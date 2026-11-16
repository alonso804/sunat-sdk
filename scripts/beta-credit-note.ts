/**
 * Envía a BETA (sin efecto tributario) una factura y notas de crédito que la modifican, y variantes del XML, para ver
 * qué acepta o rechaza realmente SUNAT. Las variantes se arman alterando el XML ANTES de firmar.
 *   pnpm tsx scripts/beta-credit-note.ts
 */
import { SunatClient } from '../src';
import { CreditNoteSchema } from '../src/credit-note/schema';
import { buildCreditNoteXml, creditNoteBaseName } from '../src/credit-note/xml';
import { calculateInvoice } from '../src/invoice/calculate';
import { signUblXml } from '../src/signing/xmldsig';
import { sampleCreditNote, sampleInvoice, TEST_ISSUER, testCertificate } from '../test/helpers';

const { key } = testCertificate();
const client = new SunatClient({
  environment: 'beta',
  issuer: TEST_ISSUER,
  sol: { user: 'MODDATOS', password: 'MODDATOS' },
  signingKey: key,
});
const today = new Date();
let n = Math.floor(Date.now() / 1000) % 98_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function show(label: string, send: () => Promise<{ status: string; [k: string]: unknown }>) {
  await sleep(2500); // el proxy de SUNAT responde 401 ante ráfagas
  try {
    const r = await send();
    const detail =
      r.status === 'rejected'
        ? `${r.code}: ${r.message}`
        : r.status === 'accepted_with_observations'
          ? `observaciones: ${(r.cdr as { notes: string[] }).notes.join(' | ')}`
          : '';
    console.log(`${label.padEnd(70)} → ${r.status} ${detail}`);
  } catch (error) {
    console.log(`${label.padEnd(70)} → ERROR ${(error as Error).message}`);
  }
}

/** Nota armada con el XML alterado por `tweak` antes de firmar. */
function variant(overrides: Parameters<typeof sampleCreditNote>[0], tweak: (xml: string) => string = (x) => x) {
  const note = CreditNoteSchema.parse(sampleCreditNote({ number: ++n, issuedAt: today, ...overrides }));
  const xml = tweak(
    buildCreditNoteXml({
      issuer: client.issuer,
      note,
      reasonDescription: 'PRUEBA',
      calculation: calculateInvoice(note),
      issuedAt: today,
    }),
  );
  return { baseName: creditNoteBaseName(client.issuer.ruc, note), signedXml: signUblXml(xml, key, 'sha1') } as never;
}

const invoiceNumber = ++n;
const invoice = client.prepareInvoice(sampleInvoice({ number: invoiceNumber, issuedAt: today }));
await show(`factura F001-${invoiceNumber} (control)`, () => client.sendInvoice(invoice));
const modified = { series: 'F001', number: invoiceNumber };

await show('NC normal (SDK) sobre la factura', () =>
  client.sendCreditNote(
    client.prepareCreditNote(sampleCreditNote({ number: ++n, issuedAt: today, modifiedDocument: modified })),
  ),
);
await show('NC con CreditNoteDocumentReference', () =>
  client.sendCreditNote(
    variant({ modifiedDocument: modified }, (x) =>
      x.replace(/InvoiceDocumentReference/g, 'CreditNoteDocumentReference'),
    ),
  ),
);
await show('NC con LegalMonetaryTotal de 3 importes', () =>
  client.sendCreditNote(
    variant({ modifiedDocument: modified }, (x) =>
      x.replace(
        /<cac:LegalMonetaryTotal>(<cbc:PayableAmount currencyID="PEN">([\d.]+)<\/cbc:PayableAmount>)/,
        (_m, pay: string, v: string) =>
          `<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="PEN">${(Number(v) / 1.18).toFixed(2)}</cbc:LineExtensionAmount><cbc:TaxInclusiveAmount currencyID="PEN">${v}</cbc:TaxInclusiveAmount>${pay}`,
      ),
    ),
  ),
);
await show('NC con atributos de catálogo en DocumentTypeCode', () =>
  client.sendCreditNote(
    variant({ modifiedDocument: modified }, (x) =>
      x.replace(
        /(<cac:InvoiceDocumentReference><cbc:ID>[^<]+<\/cbc:ID>)<cbc:DocumentTypeCode>/,
        '$1<cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">',
      ),
    ),
  ),
);
await show('NC sobre una factura que NO existe (F001-99999999)', () =>
  client.sendCreditNote(
    client.prepareCreditNote(
      sampleCreditNote({ number: ++n, issuedAt: today, modifiedDocument: { series: 'F001', number: 99999999 } }),
    ),
  ),
);
await show('NC sobre factura de otra serie (E001-867, como las de SOL)', () =>
  client.sendCreditNote(
    client.prepareCreditNote(
      sampleCreditNote({ number: ++n, issuedAt: today, modifiedDocument: { series: 'E001', number: 867 } }),
    ),
  ),
);
for (const reason of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'] as const) {
  await show(`NC motivo ${reason}`, () =>
    client.sendCreditNote(
      client.prepareCreditNote(
        sampleCreditNote({
          number: ++n,
          issuedAt: today,
          modifiedDocument: modified,
          reason,
          ...(reason === '02' ? { replacementInvoice: { series: 'F001', number: invoiceNumber } } : {}),
        }),
      ),
    ),
  );
}
await show('NC en USD con ítems exonerado e inafecto', () =>
  client.sendCreditNote(
    client.prepareCreditNote(
      sampleCreditNote({
        number: ++n,
        issuedAt: today,
        modifiedDocument: modified,
        currency: 'USD',
        items: [
          { description: 'EXONERADO', quantity: 1, unitPrice: 50, igvAffectation: '20' },
          { description: 'INAFECTO', quantity: 2, unitValue: 10, igvAffectation: '30' },
          { description: 'GRAVADO', quantity: 1, unitPrice: 118 },
        ],
      }),
    ),
  ),
);
