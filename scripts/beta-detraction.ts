/**
 * Envía a BETA (sin efecto tributario) facturas con detracción, armadas con la API
 * pública del SDK, para ver que SUNAT las acepta sin observaciones.
 *   pnpm tsx scripts/beta-detraction.ts
 */
import { type InvoiceInput, SunatClient } from '../src';
import { sampleInvoice, TEST_ISSUER, testCertificate } from '../test/helpers';

const { key } = testCertificate();
const client = new SunatClient({
  environment: 'beta',
  issuer: TEST_ISSUER,
  sol: { user: 'MODDATOS', password: 'MODDATOS' },
  signingKey: key,
});
const today = new Date();
const due = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(
  new Date(today.getTime() + 30 * 86_400_000),
);
let n = Math.floor(Date.now() / 1000) % 98_000_000;

/** Servicio de S/ 1 000 + IGV (total 1 180.00; la detracción de 12 % es 141.60). */
const service = (extra: Partial<InvoiceInput>): InvoiceInput =>
  sampleInvoice({
    number: ++n,
    issuedAt: today,
    items: [{ description: 'SERVICIO DE MANTENIMIENTO', quantity: 1, unitValue: 1000, unit: 'ZZ' }],
    ...extra,
  });

const account = '00098765432';
const cases: Array<[string, InvoiceInput]> = [
  ['sin detracción, con dirección del cliente', service({})],
  ['detracción (monto calculado), contado', service({ detraction: { account } })],
  ['detracción con monto escrito (141.60), contado', service({ detraction: { account, amount: '141.60' } })],
  [
    'detracción, crédito 1 cuota (neto pendiente = total - detracción)',
    service({ detraction: { account }, payment: { type: 'credit', installments: [{ dueDate: due }] } }),
  ],
  [
    'detracción, crédito + orden de compra + guía EG07 + nota (como la factura E001-880)',
    service({
      detraction: { account },
      payment: { type: 'credit', installments: [{ dueDate: due }] },
      purchaseOrder: '4800106291',
      relatedDespatches: [{ series: 'EG07', number: 656 }],
      note: 'HES: 1000501516',
    }),
  ],
];

for (const [label, input] of cases) {
  await new Promise((r) => setTimeout(r, 2500)); // el proxy de SUNAT responde 401 ante ráfagas
  try {
    const result = await client.sendInvoice(client.prepareInvoice(input));
    const detail =
      result.status === 'rejected'
        ? `${result.code}: ${result.message}`
        : result.status === 'accepted_with_observations'
          ? `observaciones: ${result.cdr.notes.join(' | ')}`
          : '';
    console.log(`${label.padEnd(82)} → ${result.status} ${detail}`);
  } catch (error) {
    console.log(`${label.padEnd(82)} → ERROR ${(error as Error).message}`);
  }
}
