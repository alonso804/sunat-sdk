/**
 * Envía a BETA (sin efecto tributario) facturas al crédito, con guía relacionada y orden de compra, para ver qué
 * reglas valida realmente SUNAT. Algunos casos se arman SALTÁNDOSE la validación local a propósito.
 *   pnpm tsx scripts/beta-credit.ts
 */
import { SunatClient } from '../src';
import { calculateInvoice } from '../src/invoice/calculate';
import type { ResolvedPayment } from '../src/invoice/payment';
import { InvoiceSchema } from '../src/invoice/schema';
import { buildInvoiceXml, invoiceBaseName } from '../src/invoice/xml';
import { D } from '../src/money';
import { signUblXml } from '../src/signing/xmldsig';
import { sampleInvoice, TEST_ISSUER, testCertificate } from '../test/helpers';

const { key } = testCertificate();
const client = new SunatClient({
  environment: 'beta',
  issuer: TEST_ISSUER,
  sol: { user: 'MODDATOS', password: 'MODDATOS' },
  signingKey: key,
});
const oneItem = [{ description: 'CHALECO EN TELA DENIM (TALLA: S)', quantity: 1, unitValue: 12 }];
const today = new Date();
const iso = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(today.getTime() + days * 86_400_000));
const money = (v: string) => new D(v);

let n = Math.floor(Date.now() / 1000) % 98_000_000;

/** Arma y firma la factura con la forma de pago indicada TAL CUAL (sin las validaciones locales). */
function raw(input: Parameters<typeof sampleInvoice>[0], payment: ResolvedPayment) {
  const invoice = InvoiceSchema.parse(sampleInvoice({ number: ++n, issuedAt: today, items: oneItem, ...input }));
  const xml = buildInvoiceXml({
    issuer: client.issuer,
    invoice,
    calculation: calculateInvoice(invoice),
    payment,
    issuedAt: today,
  });
  const signedXml = signUblXml(xml, key, 'sha1');
  return {
    baseName: invoiceBaseName(client.issuer.ruc, invoice),
    signedXml,
    digestValue: undefined,
    issuedAt: today,
    summary: {} as never,
  };
}

const credit = (netPending: string, rows: Array<[string, string]>): ResolvedPayment => ({
  type: 'credit',
  netPending: money(netPending),
  installments: rows.map(([dueDate, amount], i) => ({ number: i + 1, dueDate, amount: money(amount) })),
});

const cases: Array<[string, () => ReturnType<typeof raw>]> = [
  ['OK  contado (control)', () => raw({}, { type: 'cash' })],
  ['OK  crédito 1 cuota = total, vence en 10 días', () => raw({}, credit('14.16', [[iso(10), '14.16']]))],
  [
    'OK  crédito 2 cuotas que suman el total',
    () =>
      raw(
        {},
        credit('14.16', [
          [iso(10), '10.00'],
          [iso(40), '4.16'],
        ]),
      ),
  ],
  [
    'OK  crédito + guía relacionada T001-15 + orden de compra',
    () =>
      raw(
        { purchaseOrder: '10194', relatedDespatches: [{ series: 'T001', number: 15 }] },
        credit('14.16', [[iso(10), '14.16']]),
      ),
  ],
  ['??  cuotas NO suman el monto neto pendiente (10 vs 14.16)', () => raw({}, credit('14.16', [[iso(10), '10.00']]))],
  ['??  monto neto pendiente MAYOR al total (100 vs 14.16)', () => raw({}, credit('100.00', [[iso(10), '100.00']]))],
  [
    '??  monto neto pendiente MENOR al total (10 vs 14.16), 1 cuota de 10',
    () => raw({}, credit('10.00', [[iso(10), '10.00']])),
  ],
  ['??  vencimiento ANTERIOR a la emisión', () => raw({}, credit('14.16', [[iso(-5), '14.16']]))],
  ['??  vencimiento IGUAL a la fecha de emisión', () => raw({}, credit('14.16', [[iso(0), '14.16']]))],
  [
    '??  cuotas con fechas DESORDENADAS',
    () =>
      raw(
        {},
        credit('14.16', [
          [iso(40), '10.00'],
          [iso(10), '4.16'],
        ]),
      ),
  ],
  [
    '??  guía relacionada de la serie EG07 (la de SOL)',
    () => raw({ relatedDespatches: [{ series: 'EG07', number: 657 }] }, { type: 'cash' }),
  ],
];

for (const [label, build] of cases) {
  await new Promise((r) => setTimeout(r, 2500)); // el proxy de SUNAT responde 401 ante ráfagas
  try {
    const result = await client.sendInvoice(build());
    const detail =
      result.status === 'rejected'
        ? `${result.code}: ${result.message}`
        : result.status === 'accepted_with_observations'
          ? `observaciones: ${result.cdr.notes.join(' | ')}`
          : '';
    console.log(`${label.padEnd(72)} → ${result.status} ${detail}`);
  } catch (error) {
    console.log(`${label.padEnd(72)} → ERROR ${(error as Error).message}`);
  }
}
