import { describe, expect, it } from 'vitest';
import { SunatClient, SunatValidationError } from '../src';
import { sampleInvoice, TEST_ISSUER, testCertificate, validateAgainstUbl } from './helpers';

const { key } = testCertificate();
const client = new SunatClient({
  environment: 'beta',
  issuer: TEST_ISSUER,
  sol: { user: 'MODDATOS', password: 'MODDATOS' },
  signingKey: key,
});

const ACCOUNT = '00116008076';
// Servicio de 1 000 + IGV: total 1 180.00; el 12 % es 141.60. Mismo ejemplo que se probó contra SUNAT beta.
const service = { items: [{ description: 'SERVICIO DE MANTENIMIENTO', quantity: 1, unitValue: 1000, unit: 'ZZ' }] };
const withDetraction = (extra: Parameters<typeof sampleInvoice>[0] = {}) =>
  sampleInvoice({ ...service, detraction: { account: ACCOUNT }, ...extra });

function issues(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof SunatValidationError) return error.issues.map((i) => `${i.path}: ${i.message}`);
    throw error;
  }
  return [];
}

describe('detracción', () => {
  it('sin `detraction` la factura sale sin nada de detracción (tipo 0101)', () => {
    const { signedXml, summary } = client.prepareInvoice(sampleInvoice(service));
    expect(signedXml).toContain('<cbc:InvoiceTypeCode listID="0101">01</cbc:InvoiceTypeCode>');
    expect(signedXml).not.toContain('Detraccion');
    expect(signedXml).not.toContain('languageLocaleID="2006"');
    expect(summary.detraction).toBeUndefined();
  });

  it('con `detraction`: tipo 1001, leyenda 2006, cuenta, 037, 001, 12 % y el 12 % del total como monto', () => {
    const { signedXml, summary } = client.prepareInvoice(withDetraction());
    expect(signedXml).toContain('<cbc:InvoiceTypeCode listID="1001">01</cbc:InvoiceTypeCode>');
    expect(signedXml).toContain('<cbc:Note languageLocaleID="2006">Operación sujeta a detracción</cbc:Note>');
    expect(signedXml).toContain(
      `<cac:PaymentMeans><cbc:ID>Detraccion</cbc:ID><cbc:PaymentMeansCode>001</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>${ACCOUNT}</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>`,
    );
    expect(signedXml).toContain(
      '<cac:PaymentTerms><cbc:ID>Detraccion</cbc:ID><cbc:PaymentMeansID>037</cbc:PaymentMeansID><cbc:PaymentPercent>12.00</cbc:PaymentPercent><cbc:Amount currencyID="PEN">141.60</cbc:Amount></cac:PaymentTerms>',
    );
    // La detracción no cambia los totales del comprobante.
    expect(signedXml).toContain('<cbc:PayableAmount currencyID="PEN">1180.00</cbc:PayableAmount>');
    expect(summary.detraction).toEqual({ account: ACCOUNT, percent: '12.00', amount: '141.60' });
  });

  it('respeta el monto escrito y acepta 0101 o 1001 como tipo de operación', () => {
    const { summary } = client.prepareInvoice(
      withDetraction({ operationType: '1001', detraction: { account: ACCOUNT, amount: '141.65' } }),
    );
    expect(summary.detraction?.amount).toBe('141.65');
  });

  it('rechaza otro tipo de operación, un monto lejano al 12 %, un monto mayor al total y una cuenta mal escrita', () => {
    expect(issues(() => client.prepareInvoice(withDetraction({ operationType: '0200' })))).toEqual([
      expect.stringContaining('operationType'),
    ]);
    expect(
      issues(() => client.prepareInvoice(withDetraction({ detraction: { account: ACCOUNT, amount: '100' } }))),
    ).toEqual([expect.stringContaining('detraction.amount')]);
    expect(
      issues(() => client.prepareInvoice(withDetraction({ detraction: { account: ACCOUNT, amount: '2000' } }))),
    ).toContainEqual(expect.stringContaining('mayor al total'));
    expect(issues(() => client.prepareInvoice(withDetraction({ detraction: { account: '001-16008076' } })))).toEqual([
      expect.stringContaining('detraction.account'),
    ]);
  });

  it('en dólares exige el monto en soles, y no lo compara con el 12 % del total', () => {
    expect(issues(() => client.prepareInvoice(withDetraction({ currency: 'USD' })))).toEqual([
      expect.stringContaining('detraction.amount'),
    ]);
    const { signedXml } = client.prepareInvoice(
      withDetraction({ currency: 'USD', detraction: { account: ACCOUNT, amount: '530.40' } }),
    );
    expect(signedXml).toContain('<cbc:Amount currencyID="PEN">530.40</cbc:Amount>');
  });

  it('a crédito, el monto neto pendiente por defecto es el total menos la detracción (como SOL)', () => {
    // Ejemplo de SOL: total 2 103.94, detracción 252.47 → neto pendiente 1 851.47.
    const { summary } = client.prepareInvoice(
      withDetraction({
        items: [{ description: 'RECARGA DE EXTINTORES', quantity: 1, unitValue: 1783, unit: 'ZZ' }],
        detraction: { account: ACCOUNT },
        payment: { type: 'credit', installments: [{ dueDate: '2026-12-11' }] },
      }),
    );
    expect(summary.total).toBe('2103.94');
    expect(summary.detraction?.amount).toBe('252.47');
    expect(summary.payment).toEqual({
      type: 'credit',
      netPending: '1851.47',
      installments: [{ number: 1, dueDate: '2026-12-11', amount: '1851.47' }],
    });
  });

  it('a crédito en dólares con detracción exige el monto neto pendiente', () => {
    expect(
      issues(() =>
        client.prepareInvoice(
          withDetraction({
            currency: 'USD',
            detraction: { account: ACCOUNT, amount: '530.40' },
            payment: { type: 'credit', installments: [{ dueDate: '2026-12-11' }] },
          }),
        ),
      ),
    ).toEqual([expect.stringContaining('payment.netPending')]);
  });

  it('el XML con detracción y a crédito cumple el esquema UBL 2.1', async () => {
    const { signedXml } = client.prepareInvoice(
      withDetraction({
        payment: { type: 'credit', installments: [{ dueDate: '2026-12-11' }] },
      }),
    );
    const result = await validateAgainstUbl(signedXml, 'Invoice');
    expect(result.errors).toBe('');
    expect(result.valid).toBe(true);
  });
});

describe('dirección de entrega', () => {
  // El XML de SOL (E001-880, con "Consigne la dirección donde entregue" = Sí) no lleva cac:Delivery ni cac:DeliveryTerms:
  // la dirección es la del cliente (AccountingCustomerParty). SUNAT trata cac:Delivery como venta itinerante (4266).
  it('no emite bloques de entrega: la dirección va en la del cliente y el establecimiento del emisor es 0000', () => {
    const { signedXml } = client.prepareInvoice(sampleInvoice());
    expect(signedXml).not.toContain('<cac:Delivery');
    expect(signedXml).toContain('<cbc:Line>AV. GARCILASO DE LA VEGA 1472 LIMA</cbc:Line>');
    expect(signedXml).toContain('<cbc:AddressTypeCode>0000</cbc:AddressTypeCode>');
  });
});
