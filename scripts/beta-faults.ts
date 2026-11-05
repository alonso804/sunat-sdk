/**
 * Observa respuestas REALES de error de SUNAT beta enviando XML defectuosos a propósito.
 * Sirve para comprobar que parseSendBillResponse entiende los SOAP Fault verdaderos.
 *
 *   pnpm tsx scripts/beta-faults.ts
 */
import { InvoiceSchema, IssuerSchema, SunatFaultError } from '../src';
import { ENDPOINTS } from '../src/config';
import { calculateInvoice } from '../src/invoice/calculate';
import { resolvePayment } from '../src/invoice/payment';
import { buildInvoiceXml } from '../src/invoice/xml';
import { signUblXml } from '../src/signing/xmldsig';
import { sendBill } from '../src/soap/bill-service';
import { limaDateTime } from '../src/xml';
import { zipSingleFile } from '../src/zip';
import { sampleInvoice, TEST_ISSUER, TEST_RUC, testCertificate } from '../test/helpers';

const { key } = testCertificate();
const issuer = IssuerSchema.parse(TEST_ISSUER);
const auth = { username: `${TEST_RUC}MODDATOS`, password: 'MODDATOS' };

function freshNumber(offset: number): number {
  return (Math.floor(Date.now() / 1000) % 99_000_000) + offset;
}

function unsignedXml(number: number): string {
  const issuedAt = new Date();
  const invoice = InvoiceSchema.parse(sampleInvoice({ number, issuedAt }));
  const calculation = calculateInvoice(invoice);
  // Igual que SunatClient.prepareInvoice: la forma de pago se resuelve contra el total y la fecha de emisión.
  const payment = resolvePayment(invoice.payment, calculation.totals.payable, limaDateTime(issuedAt).date);
  return buildInvoiceXml({ issuer, invoice, calculation, payment, issuedAt });
}

/** Imprime la respuesta cruda cuando no es un 200, para diagnosticar. */
const loggingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status !== 200 && response.status !== 500) {
    console.log(`  [HTTP ${response.status}] headers: ${JSON.stringify(Object.fromEntries(response.headers))}`);
    console.log(`  [cuerpo] ${(await response.clone().text()).slice(0, 800)}`);
  }
  return response;
};

async function attempt(label: string, fileBase: string, xml: string): Promise<void> {
  console.log(`\n=== ${label}`);
  try {
    const zip = zipSingleFile(`${fileBase}.xml`, xml);
    await sendBill({
      endpoint: ENDPOINTS.beta.billService,
      auth,
      fileName: `${fileBase}.zip`,
      zipBase64: Buffer.from(zip).toString('base64'),
      fetch: loggingFetch,
    });
    console.log('→ SUNAT la aceptó (sin fault)');
  } catch (error) {
    if (error instanceof SunatFaultError) {
      console.log(`→ SunatFaultError code=${error.code} kind=${error.kind} http=${error.httpStatus}`);
      console.log(`  mensaje: ${error.sunatMessage}`);
    } else {
      console.log('→ otro error:', error);
    }
  }
}

const want = (id: string) => process.argv.length <= 2 || process.argv.slice(2).includes(id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const n1 = freshNumber(1);
if (want('a'))
  await attempt(
    'a) Falta cbc:IssueDate (estructura inválida)',
    `${TEST_RUC}-01-F001-${n1}`,
    signUblXml(unsignedXml(n1).replace(/<cbc:IssueDate>[^<]*<\/cbc:IssueDate>/, ''), key),
  );

const n2 = freshNumber(2);
if (want('b'))
  await attempt(
    'b) El nombre del archivo no coincide con el ID del documento',
    `${TEST_RUC}-01-F001-${n2 + 100}`,
    signUblXml(unsignedXml(n2), key),
  );

const n3 = freshNumber(3);
if (want('c'))
  await attempt(
    'c) Se altera el monto DESPUÉS de firmar',
    `${TEST_RUC}-01-F001-${n3}`,
    signUblXml(unsignedXml(n3), key).replace(
      '<cbc:PayableAmount currencyID="PEN">413.00',
      '<cbc:PayableAmount currencyID="PEN">999.00',
    ),
  );

const n4 = freshNumber(4);
if (want('d')) await attempt('d) Documento sin firmar', `${TEST_RUC}-01-F001-${n4}`, unsignedXml(n4));

const n5 = freshNumber(5);
if (want('e'))
  await attempt(
    'e) Totales que no cuadran (IGV incorrecto), firmado',
    `${TEST_RUC}-01-F001-${n5}`,
    signUblXml(unsignedXml(n5).replaceAll('currencyID="PEN">63.00', 'currencyID="PEN">10.00'), key),
  );

const n6 = freshNumber(6);
if (want('ok')) {
  await sleep(1500);
  await attempt('ok) CONTROL: factura válida', `${TEST_RUC}-01-F001-${n6}`, signUblXml(unsignedXml(n6), key));
}
