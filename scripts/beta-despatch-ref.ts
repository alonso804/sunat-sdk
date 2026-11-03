/** Prueba en BETA variantes de los atributos de cac:DespatchDocumentReference/cbc:DocumentTypeCode. */
import { SunatClient } from '../src';
import { calculateInvoice } from '../src/invoice/calculate';
import { InvoiceSchema } from '../src/invoice/schema';
import { buildInvoiceXml, invoiceBaseName } from '../src/invoice/xml';
import { signUblXml } from '../src/signing/xmldsig';
import { TEST_ISSUER, sampleInvoice, testCertificate } from '../test/helpers';

const { key } = testCertificate();
const client = new SunatClient({ environment: 'beta', issuer: TEST_ISSUER, sol: { user: 'MODDATOS', password: 'MODDATOS' }, signingKey: key });
const today = new Date();
let n = Math.floor(Date.now() / 1000) % 98_000_000;
const CURRENT =
  '<cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="SUNAT:Identificador de guía relacionada" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">09</cbc:DocumentTypeCode>';

const variants: Array<[string, string]> = [
  ['sin atributos', '<cbc:DocumentTypeCode>09</cbc:DocumentTypeCode>'],
  ['listName "SUNAT:Identificador de Tipo de Documento" + catalogo01', '<cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="SUNAT:Identificador de Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">09</cbc:DocumentTypeCode>'],
  ['listName "Tipo de Documento" + catalogo01', '<cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">09</cbc:DocumentTypeCode>'],
  ['listName "SUNAT:Identificador de guía relacionada" + catalogo12', '<cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="SUNAT:Identificador de guía relacionada" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo12">09</cbc:DocumentTypeCode>'],
];

for (const [label, replacement] of variants) {
  await new Promise((r) => setTimeout(r, 2500));
  const invoice = InvoiceSchema.parse(
    sampleInvoice({ number: ++n, issuedAt: today, items: [{ description: 'CHALECO', quantity: 1, unitValue: 12 }], relatedDespatches: [{ series: 'T001', number: 15 }] }),
  );
  const unsigned = buildInvoiceXml({ issuer: client.issuer, invoice, calculation: calculateInvoice(invoice), payment: { type: 'cash' }, issuedAt: today });
  if (!unsigned.includes(CURRENT)) throw new Error('No se encontró el DocumentTypeCode esperado.');
  const signedXml = signUblXml(unsigned.replace(CURRENT, replacement), key, 'sha1');
  const result = await client.sendInvoice({ baseName: invoiceBaseName(client.issuer.ruc, invoice), signedXml, digestValue: undefined, issuedAt: today, summary: {} as never });
  const detail = result.status === 'accepted_with_observations' ? `observaciones: ${result.cdr.notes.join(' | ')}` : result.status === 'rejected' ? `${result.code}: ${result.message}` : '';
  console.log(`${label.padEnd(70)} → ${result.status} ${detail}`);
}
