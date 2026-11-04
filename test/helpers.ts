import { readdirSync, readFileSync } from 'node:fs';
import { strToU8 } from 'fflate';
import forge from 'node-forge';
import { validateXML } from 'xmllint-wasm';
import type { DespatchInput, InvoiceInput, IssuerInput } from '../src';
import type { SigningKey } from '../src/signing/certificate';
import { zipSingleFile } from '../src/zip';

/** RUC de pruebas del ambiente beta de SUNAT (dígito verificador válido). */
export const TEST_RUC = '20000000001';
/** RUC de SUNAT, existente y público: sirve como cliente de prueba. */
export const CUSTOMER_RUC = '20131312955';

export const TEST_ISSUER: IssuerInput = {
  ruc: TEST_RUC,
  legalName: 'EMPRESA DE PRUEBAS SAC',
  tradeName: 'PRUEBAS',
  address: {
    ubigeo: '150101',
    department: 'LIMA',
    province: 'LIMA',
    district: 'LIMA',
    street: 'AV. DE PRUEBA 123',
  },
};

export function sampleInvoice(overrides: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    series: 'F001',
    number: 1,
    issuedAt: new Date('2026-10-31T15:30:00-05:00'),
    customer: {
      ruc: CUSTOMER_RUC,
      name: 'SUPERINTENDENCIA NACIONAL DE ADUANAS Y DE ADMINISTRACION TRIBUTARIA - SUNAT',
      address: 'AV. GARCILASO DE LA VEGA 1472 LIMA',
    },
    items: [
      { description: 'CEMENTO SOL TIPO I 42.5 KG', quantity: 10, unitPrice: 29.5, productCode: 'CEM001' },
      { description: 'PINTURA LATEX BLANCO 1 GL', quantity: 2, unitPrice: 59 },
    ],
    ...overrides,
  };
}

/** GRE remitente de ejemplo: venta con transporte privado. */
export function sampleDespatch(overrides: Partial<DespatchInput> = {}): DespatchInput {
  return {
    series: 'T001',
    number: 1,
    issuedAt: new Date('2026-10-31T15:30:00-05:00'),
    reason: '01',
    recipient: {
      docType: '6',
      docNumber: CUSTOMER_RUC,
      name: 'SUPERINTENDENCIA NACIONAL DE ADUANAS Y DE ADMINISTRACION TRIBUTARIA - SUNAT',
    },
    transportMode: 'private',
    transferStartDate: '2026-11-02',
    grossWeight: { value: '425.5', unit: 'KGM' },
    packages: 12,
    origin: { ubigeo: '150101', address: 'AV. DE PRUEBA 123, LIMA' },
    destination: { ubigeo: '150140', address: 'AV. CAMINOS DEL INCA 456, SANTIAGO DE SURCO' },
    vehicle: { plate: 'abc-123' },
    drivers: [{ docNumber: '12345678', firstName: 'JUAN', lastName: 'PEREZ GOMEZ', license: 'Q12345678' }],
    items: [
      { description: 'CEMENTO SOL TIPO I 42.5 KG', quantity: 10, code: 'CEM001' },
      { description: 'PINTURA LATEX BLANCO 1 GL', quantity: 2 },
    ],
    relatedDocuments: [{ type: '01', number: 'F001-123', issuerRuc: TEST_RUC }],
    ...overrides,
  };
}

/** Esquemas UBL 2.1 de OASIS (test/xsd): el principal de cada documento está en maindoc/ e importa los de common/. */
const XSD_DIR = new URL('./xsd/ubl-2.1/', import.meta.url);
const XSD_MAIN = { Invoice: 'UBL-Invoice-2.1.xsd', DespatchAdvice: 'UBL-DespatchAdvice-2.1.xsd' } as const;

type SchemaFile = { fileName: string; contents: string };
let commonSchemas: SchemaFile[] | undefined;

/** Los esquemas de common/ que importan los principales (se leen una sola vez). */
function loadCommonSchemas(): SchemaFile[] {
  if (!commonSchemas) {
    const dir = new URL('common/', XSD_DIR);
    commonSchemas = readdirSync(dir).map((name) => ({
      fileName: `common/${name}`,
      contents: readFileSync(new URL(name, dir), 'utf8'),
    }));
  }
  return commonSchemas;
}

/**
 * Valida un XML contra el esquema UBL 2.1 oficial de OASIS (el que usa SUNAT) con `xmllint-wasm`: libxml2 compilado a
 * WebAssembly, así que no hace falta instalar xmllint y las pruebas corren igual en Windows, macOS, Linux y CI.
 * `errors` queda vacío si el XML es válido.
 */
export async function validateAgainstUbl(
  xml: string,
  type: keyof typeof XSD_MAIN,
): Promise<{ valid: boolean; errors: string }> {
  const main = `maindoc/${XSD_MAIN[type]}`;
  const result = await validateXML({
    xml: [{ fileName: 'document.xml', contents: xml }],
    schema: [{ fileName: main, contents: readFileSync(new URL(main, XSD_DIR), 'utf8') }],
    preload: loadCommonSchemas(),
  });
  return { valid: result.valid, errors: result.errors.map((error) => error.message).join('\n') };
}

/** `arcCdr` de la API de guías: el CDR dentro de un ZIP, en base64. */
export function cdrZipBase64(baseName: string, cdr: string): string {
  return Buffer.from(zipSingleFile(`R-${baseName}.xml`, strToU8(cdr))).toString('base64');
}

let cached:
  | { key: SigningKey; pfx: Uint8Array; privateKey: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate }
  | undefined;

/** Certificado autofirmado de prueba (se genera una sola vez por proceso de test). */
export function testCertificate() {
  if (!cached) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    const attrs = [
      { name: 'countryName', value: 'PE' },
      { name: 'organizationName', value: 'EMPRESA DE PRUEBAS SAC' },
      { shortName: 'OU', value: TEST_RUC },
      { name: 'commonName', value: 'EMPRESA DE PRUEBAS SAC' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'secreto', { algorithm: '3des' });
    const pfx = new Uint8Array(Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));

    cached = {
      key: {
        privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
        certificatePem: forge.pki.certificateToPem(cert),
      },
      pfx,
      privateKey: keys.privateKey,
      cert,
    };
  }
  return cached;
}

export function cdrXml(options: { reference: string; code: string; description: string; notes?: string[] }): string {
  const notes = (options.notes ?? []).map((n) => `<cbc:Note>${n}</cbc:Note>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
    '<ar:ApplicationResponse xmlns:ar="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" ' +
    'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ' +
    'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" ' +
    'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">' +
    '<cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>1.0</cbc:CustomizationID>' +
    '<cbc:ID>202610311234</cbc:ID><cbc:ResponseDate>2026-10-31</cbc:ResponseDate><cbc:ResponseTime>15:30:05</cbc:ResponseTime>' +
    notes +
    '<cac:DocumentResponse><cac:Response>' +
    `<cbc:ReferenceID>${options.reference}</cbc:ReferenceID>` +
    `<cbc:ResponseCode>${options.code}</cbc:ResponseCode>` +
    `<cbc:Description>${options.description}</cbc:Description>` +
    '</cac:Response></cac:DocumentResponse>' +
    '</ar:ApplicationResponse>'
  );
}

/** Respuesta SOAP exitosa de sendBill con el CDR dentro de un ZIP en base64. */
export function sendBillOkResponse(baseName: string, cdr: string): string {
  const zip = zipSingleFile(`R-${baseName}.xml`, strToU8(cdr));
  return (
    '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>' +
    '<br:sendBillResponse xmlns:br="http://service.sunat.gob.pe">' +
    `<applicationResponse>${Buffer.from(zip).toString('base64')}</applicationResponse>` +
    '</br:sendBillResponse></S:Body></S:Envelope>'
  );
}

export function faultResponse(faultcode: string, faultstring: string): string {
  return (
    '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"><soap-env:Body>' +
    `<soap-env:Fault><faultcode>${faultcode}</faultcode><faultstring>${faultstring}</faultstring></soap-env:Fault>` +
    '</soap-env:Body></soap-env:Envelope>'
  );
}
