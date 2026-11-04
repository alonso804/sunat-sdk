import { XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { SunatClient, SunatValidationError } from '../src';
import { describeCertificate, signingKeyFromPfx } from '../src/signing/certificate';
import { verifyUblSignature } from '../src/signing/xmldsig';
import { sampleInvoice, TEST_ISSUER, TEST_RUC, testCertificate } from './helpers';

const { key, pfx } = testCertificate();
const makeClient = (algorithm?: 'sha1' | 'sha256') =>
  new SunatClient({
    environment: 'beta',
    issuer: TEST_ISSUER,
    sol: { user: 'MODDATOS', password: 'MODDATOS' },
    signingKey: key,
    ...(algorithm ? { signatureAlgorithm: algorithm } : {}),
  });

describe('prepareInvoice', () => {
  it('genera un XML bien formado, firmado y con los datos esperados', () => {
    const prepared = makeClient().prepareInvoice(sampleInvoice());
    const xml = prepared.signedXml;

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(prepared.baseName).toBe(`${TEST_RUC}-01-F001-1`);
    expect(xml).toContain('<cbc:ID>F001-1</cbc:ID>');
    expect(xml).toContain('<cbc:IssueDate>2026-10-31</cbc:IssueDate>');
    expect(xml).toContain('<cbc:IssueTime>15:30:00</cbc:IssueTime>');
    expect(xml).toContain('<cbc:InvoiceTypeCode listID="0101">01</cbc:InvoiceTypeCode>');
    expect(xml).toContain('languageLocaleID="1000">SON: CUATROCIENTOS TRECE CON 00/100 SOLES');
    expect(xml).toContain('<cbc:PayableAmount currencyID="PEN">413.00</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:PaymentMeansID>Contado</cbc:PaymentMeansID>');
    expect(prepared.digestValue).toBeTruthy();
  });

  it('normaliza el código de país del emisor y rechaza uno inválido', () => {
    const withCountry = (countryCode: string) =>
      new SunatClient({
        environment: 'beta',
        issuer: { ...TEST_ISSUER, address: { ...TEST_ISSUER.address, countryCode } },
        sol: { user: 'MODDATOS', password: 'MODDATOS' },
        signingKey: key,
      });
    expect(withCountry('pe').issuer.address.countryCode).toBe('PE');
    expect(() => withCountry('<a')).toThrow(SunatValidationError);
    expect(() => withCountry('PER')).toThrow(SunatValidationError);
  });

  it('coloca la firma dentro de ext:ExtensionContent e incluye el certificado', () => {
    const { signedXml } = makeClient().prepareInvoice(sampleInvoice());
    expect(signedXml).toMatch(/<ext:ExtensionContent><ds:Signature[^>]*Id="SignatureSP"/);
    expect(signedXml).toContain('<ds:X509Certificate>');
    expect(signedXml).toContain('http://www.w3.org/2000/09/xmldsig#rsa-sha1');
  });

  it.each(['sha1', 'sha256'] as const)('la firma %s se verifica con el certificado', (algorithm) => {
    const { signedXml } = makeClient(algorithm).prepareInvoice(sampleInvoice());
    expect(verifyUblSignature(signedXml, key.certificatePem)).toBe(true);
  });

  it('detecta si el documento se altera después de firmar', () => {
    const { signedXml } = makeClient().prepareInvoice(sampleInvoice());
    const tampered = signedXml.replace('413.00', '999.00');
    expect(tampered).not.toBe(signedXml);
    expect(verifyUblSignature(tampered, key.certificatePem)).toBe(false);
  });

  it('escapa caracteres especiales en descripciones', () => {
    const { signedXml } = makeClient().prepareInvoice(
      sampleInvoice({ items: [{ description: 'TUBO 1/2" & CODO <90°>', quantity: 1, unitPrice: 11.8 }] }),
    );
    expect(XMLValidator.validate(signedXml)).toBe(true);
    // Dentro de texto basta escapar & < > (las comillas son válidas tal cual).
    expect(signedXml).toContain('TUBO 1/2" &amp; CODO &lt;90°&gt;');
  });

  it('emite subtotales de tributos por tipo de afectación', () => {
    const { signedXml } = makeClient().prepareInvoice(
      sampleInvoice({
        items: [
          { description: 'GRAVADO', quantity: 1, unitPrice: 118 },
          { description: 'EXONERADO', quantity: 1, unitPrice: 50, igvAffectation: '20' },
        ],
      }),
    );
    expect(signedXml).toContain('<cbc:ID>1000</cbc:ID><cbc:Name>IGV</cbc:Name>');
    expect(signedXml).toContain('<cbc:ID>9997</cbc:ID><cbc:Name>EXO</cbc:Name>');
    expect(signedXml).not.toContain('<cbc:Name>INA</cbc:Name>');
  });

  it('devuelve un resumen para confirmar con el usuario', () => {
    const { summary } = makeClient().prepareInvoice(sampleInvoice());
    expect(summary.total).toBe('413.00');
    expect(summary.igv).toBe('63.00');
    expect(summary.totalInWords).toBe('SON: CUATROCIENTOS TRECE CON 00/100 SOLES');
    expect(summary.lines).toHaveLength(2);
  });

  it('lanza SunatValidationError con el detalle de los campos inválidos', () => {
    const client = makeClient();
    expect(() => client.prepareInvoice(sampleInvoice({ series: 'X001' }))).toThrow(SunatValidationError);
    try {
      client.prepareInvoice(sampleInvoice({ items: [] }));
    } catch (error) {
      expect(error).toBeInstanceOf(SunatValidationError);
      expect((error as SunatValidationError).issues.some((i) => i.path === 'items')).toBe(true);
    }
  });

  it('rechaza un emisor con RUC inválido al crear el cliente', () => {
    expect(
      () =>
        new SunatClient({
          environment: 'beta',
          issuer: { ...TEST_ISSUER, ruc: '20000000002' },
          sol: { user: 'MODDATOS', password: 'MODDATOS' },
          signingKey: key,
        }),
    ).toThrow(SunatValidationError);
  });
});

describe('certificados', () => {
  it('extrae llave y certificado de un PFX', () => {
    const loaded = signingKeyFromPfx(pfx, 'secreto');
    expect(loaded.certificatePem).toBe(key.certificatePem);
    expect(describeCertificate(loaded.certificatePem).subject.OU).toBe(TEST_RUC);
  });

  it('da un error claro con contraseña incorrecta', () => {
    expect(() => signingKeyFromPfx(pfx, 'incorrecta')).toThrow(/contraseña/);
  });
});
