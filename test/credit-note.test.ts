import { XMLValidator } from 'fast-xml-parser';
import { describe, expect, it, vi } from 'vitest';
import { CREDIT_NOTE_REASONS, SunatClient, SunatFaultError, SunatValidationError } from '../src';
import { verifyUblSignature } from '../src/signing/xmldsig';
import { unzipFiles } from '../src/zip';
import {
  cdrXml,
  faultResponse,
  sampleCreditNote,
  sampleInvoice,
  sendBillOkResponse,
  TEST_ISSUER,
  TEST_RUC,
  testCertificate,
  validateAgainstUbl,
} from './helpers';

const { key } = testCertificate();
const makeClient = (opts: { algorithm?: 'sha1' | 'sha256'; fetch?: typeof fetch; textCharset?: 'latin1' } = {}) =>
  new SunatClient({
    environment: 'beta',
    issuer: TEST_ISSUER,
    sol: { user: 'MODDATOS', password: 'MODDATOS' },
    signingKey: key,
    retry: { delayMs: 0 },
    ...(opts.algorithm ? { signatureAlgorithm: opts.algorithm } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.textCharset ? { textCharset: opts.textCharset } : {}),
  });

function issues(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof SunatValidationError) return error.issues.map((i) => `${i.path}: ${i.message}`);
    throw error;
  }
  return [];
}

describe('prepareCreditNote', () => {
  it('genera un XML CreditNote firmado con el comprobante modificado y el motivo', () => {
    const prepared = makeClient().prepareCreditNote(sampleCreditNote());
    const xml = prepared.signedXml;
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(prepared.baseName).toBe(`${TEST_RUC}-07-FC01-1`);
    expect(xml).toContain('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"');
    expect(xml).toContain('<cbc:ID>FC01-1</cbc:ID>');
    expect(xml).toContain(
      '<cac:DiscrepancyResponse><cbc:ReferenceID>F001-1</cbc:ReferenceID><cbc:ResponseCode>01</cbc:ResponseCode><cbc:Description>Anulación de la operación</cbc:Description></cac:DiscrepancyResponse>',
    );
    expect(xml).toContain(
      '<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>F001-1</cbc:ID><cbc:DocumentTypeCode>01</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference>',
    );
    expect(xml).toContain('<cac:CreditNoteLine>');
    expect(xml).toContain('<cbc:CreditedQuantity unitCode="NIU">10.00</cbc:CreditedQuantity>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="PEN">413.00</cbc:PayableAmount>');
    expect(xml).not.toContain('InvoiceLine>');
    expect(xml).not.toContain('PaymentTerms');
    expect(xml).toMatch(/<ext:ExtensionContent><ds:Signature[^>]*Id="SignatureSP"/);
  });

  it.each(['sha1', 'sha256'] as const)('la firma %s se verifica y detecta alteraciones', (algorithm) => {
    const { signedXml } = makeClient({ algorithm }).prepareCreditNote(sampleCreditNote());
    expect(verifyUblSignature(signedXml, key.certificatePem)).toBe(true);
    expect(verifyUblSignature(signedXml.replace('413.00', '999.00'), key.certificatePem)).toBe(false);
  });

  it('calcula los mismos totales que la factura con los mismos ítems', () => {
    const client = makeClient();
    const note = client.prepareCreditNote(sampleCreditNote()).summary;
    const invoice = client.prepareInvoice(sampleInvoice()).summary;
    expect(note.total).toBe(invoice.total);
    expect(note.igv).toBe(invoice.igv);
    expect(note.lines).toEqual(invoice.lines);
    expect(note.totalInWords).toBe('SON: CUATROCIENTOS TRECE CON 00/100 SOLES');
    expect(note.modifiedDocument).toEqual({ type: '01', number: 'F001-1' });
    expect(note.reason).toEqual({
      code: '01',
      label: 'Anulación de la operación',
      description: 'Anulación de la operación',
    });
  });

  it('usa el sustento indicado, normaliza series y escapa texto', () => {
    const { signedXml, summary } = makeClient().prepareCreditNote(
      sampleCreditNote({
        series: 'fc01',
        modifiedDocument: { series: 'e001', number: 867 },
        reason: '07',
        reasonDescription: 'Devolución de 2 "unidades" & más',
        note: 'Ref <interna>',
        currency: 'USD',
      }),
    );
    expect(signedXml).toContain('<cbc:ID>FC01-1</cbc:ID>');
    expect(signedXml).toContain('<cbc:ReferenceID>E001-867</cbc:ReferenceID>');
    expect(signedXml).toContain('Devolución de 2 "unidades" &amp; más');
    expect(signedXml).toContain('<cbc:Note>Ref &lt;interna&gt;</cbc:Note>');
    expect(signedXml).toContain('<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>');
    expect(summary.reason.label).toBe('Devolución por ítem');
  });

  it('aplica textCharset latin1 al sustento', () => {
    const { signedXml } = makeClient({ textCharset: 'latin1' }).prepareCreditNote(
      sampleCreditNote({ reasonDescription: 'Cliente “VIP” — devolución' }),
    );
    expect(signedXml).toContain('Cliente "VIP" - devolución');
  });

  it('avisa del plazo de envío y, en los motivos 02 y 03, del plazo de emisión', () => {
    const client = makeClient();
    const base = client.prepareCreditNote(sampleCreditNote()).warnings;
    expect(base.some((w) => w.includes('día calendario siguiente'))).toBe(true);
    expect(base.some((w) => w.includes('décimo día hábil'))).toBe(false);
    expect(
      client.prepareCreditNote(sampleCreditNote({ reason: '03' })).warnings.some((w) => w.includes('décimo día hábil')),
    ).toBe(true);
  });

  it('el motivo 02 admite la factura de reemplazo; con otro motivo se rechaza', () => {
    const client = makeClient();
    const { signedXml, summary } = client.prepareCreditNote(
      sampleCreditNote({ reason: '02', replacementInvoice: { series: 'F001', number: 2 } }),
    );
    expect(signedXml).toContain(
      '<cac:AdditionalDocumentReference><cbc:ID>F001-2</cbc:ID><cbc:DocumentTypeCode>01</cbc:DocumentTypeCode></cac:AdditionalDocumentReference>',
    );
    expect(summary.replacementInvoice).toBe('F001-2');
    expect(
      issues(() => client.prepareCreditNote(sampleCreditNote({ replacementInvoice: { series: 'F001', number: 2 } }))),
    ).toEqual(['replacementInvoice: Solo se indica con el motivo 02 (anulación por error en el RUC)']);
  });

  it('valida serie, motivo, comprobante modificado, cliente e ítems', () => {
    const client = makeClient();
    const bad = (overrides: Parameters<typeof sampleCreditNote>[0]) =>
      issues(() => client.prepareCreditNote(sampleCreditNote(overrides)));
    expect(bad({ series: 'B001' })).not.toEqual([]); // empieza con B: sería sobre boleta
    expect(bad({ series: 'FC1' })).not.toEqual([]);
    expect(bad({ number: 0 })).not.toEqual([]);
    expect(bad({ reason: '13' as never })).toEqual([
      'reason: El motivo 13 (corregir cuotas del crédito) aún no está soportado',
    ]);
    expect(bad({ reason: '99' as never })).toEqual(['reason: Debe ser un código 01 a 10 del catálogo 09']);
    expect(bad({ modifiedDocument: { series: 'F1', number: 1 } })).not.toEqual([]);
    expect(bad({ modifiedDocument: { series: 'F001', number: 1, type: '03' as never } })).not.toEqual([]);
    expect(bad({ reasonDescription: 'x'.repeat(251) })).not.toEqual([]);
    expect(bad({ items: [] })).not.toEqual([]);
    expect(bad({ customer: { ruc: '20131312950', name: 'X' } })).not.toEqual([]);
  });

  it('el catálogo 09 tiene los motivos 01 a 10', () => {
    expect(Object.keys(CREDIT_NOTE_REASONS).sort()).toEqual([
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
      '07',
      '08',
      '09',
      '10',
    ]);
  });
});

describe('esquema UBL 2.1 CreditNote (xmllint-wasm)', () => {
  const client = makeClient();
  it.each([
    ['simple', sampleCreditNote()],
    [
      'con IGV gravado, exonerado e inafecto, USD, nota y motivo 02 con reemplazo',
      sampleCreditNote({
        reason: '02',
        currency: 'USD',
        note: 'Observación',
        replacementInvoice: { series: 'F001', number: 2 },
        items: [
          { description: 'GRAVADO', quantity: 1, unitPrice: 118, productCode: 'A1' },
          { description: 'EXONERADO', quantity: 1, unitPrice: 50, igvAffectation: '20' },
          { description: 'INAFECTO', quantity: '2.5', unitValue: 10, igvAffectation: '30' },
        ],
      }),
    ],
  ])('es válida: %s', async (_name, input) => {
    const result = await validateAgainstUbl(client.prepareCreditNote(input).signedXml, 'CreditNote');
    expect(result.errors).toBe('');
    expect(result.valid).toBe(true);
  });
});

describe('SunatClient.sendCreditNote (fetch simulado)', () => {
  const BASE = `${TEST_RUC}-07-FC01-1`;
  const respond = (body: string, status = 200) =>
    vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

  it('envía el ZIP <RUC>-07-… y devuelve aceptada', async () => {
    const mock = respond(sendBillOkResponse(BASE, cdrXml({ reference: 'FC01-1', code: '0', description: 'aceptada' })));
    const client = makeClient({ fetch: mock });
    const result = await client.sendCreditNote(client.prepareCreditNote(sampleCreditNote()));
    expect(result.status).toBe('accepted');
    const [, init] = (mock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sent = String(init.body);
    expect(sent).toContain(`<fileName>${BASE}.zip</fileName>`);
    const base64 = /<contentFile>([^<]+)<\/contentFile>/.exec(sent)![1]!;
    expect(Object.keys(unzipFiles(new Uint8Array(Buffer.from(base64, 'base64'))))).toEqual([`${BASE}.xml`]);
  });

  it('un rechazo de validación se devuelve sin lanzar y una excepción se lanza', async () => {
    const rejected = makeClient({ fetch: respond(faultResponse('soap-env:Client.2335', 'alterado'), 500) });
    expect(await rejected.sendCreditNote(rejected.prepareCreditNote(sampleCreditNote()))).toMatchObject({
      status: 'rejected',
      code: '2335',
    });
    const exception = makeClient({ fetch: respond(faultResponse('soap-env:Client.1036', 'nombre'), 200) });
    await expect(exception.sendCreditNote(exception.prepareCreditNote(sampleCreditNote()))).rejects.toBeInstanceOf(
      SunatFaultError,
    );
  });
});
