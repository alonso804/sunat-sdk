import { describe, expect, it } from 'vitest';
import { SunatClient, SunatValidationError } from '../src';
import { TEST_ISSUER, hasXmllint, sampleInvoice, testCertificate, validateAgainstUbl } from './helpers';

const { key } = testCertificate();
const client = new SunatClient({
  environment: 'beta',
  issuer: TEST_ISSUER,
  sol: { user: 'MODDATOS', password: 'MODDATOS' },
  signingKey: key,
});

// Un solo ítem: 12.00 sin IGV → IGV 2.16 → total 14.16 (el mismo ejemplo que se vio en SOL).
const oneItem = { items: [{ description: 'CHALECO EN TELA DENIM (TALLA: S)', quantity: 1, unitValue: 12 }] };
const credit = (installments: Array<{ dueDate: string; amount?: number }>, netPending?: number) =>
  sampleInvoice({ ...oneItem, payment: { type: 'credit', installments, ...(netPending === undefined ? {} : { netPending }) } });

function issues(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof SunatValidationError) return error.issues.map((i) => `${i.path}: ${i.message}`);
    throw error;
  }
  return [];
}

describe('forma de pago', () => {
  it('por defecto es al contado (como antes)', () => {
    const { signedXml, summary } = client.prepareInvoice(sampleInvoice(oneItem));
    expect(signedXml).toContain('<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>');
    expect(signedXml).not.toContain('Credito');
    expect(summary.payment).toEqual({ type: 'cash' });
  });

  it('crédito: el monto neto pendiente es el TOTAL de la factura si no se indica', () => {
    const { summary, signedXml } = client.prepareInvoice(credit([{ dueDate: '2026-11-10' }]));
    expect(summary.total).toBe('14.16');
    expect(summary.payment).toEqual({
      type: 'credit',
      netPending: '14.16',
      installments: [{ number: 1, dueDate: '2026-11-10', amount: '14.16' }],
    });
    // Estructura del anexo 9-A: una línea "Credito" con el monto neto pendiente y una línea CuotaNNN por cuota.
    expect(signedXml).toContain(
      '<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Credito</cbc:PaymentMeansID><cbc:Amount currencyID="PEN">14.16</cbc:Amount></cac:PaymentTerms>',
    );
    expect(signedXml).toContain(
      '<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Cuota001</cbc:PaymentMeansID><cbc:Amount currencyID="PEN">14.16</cbc:Amount><cbc:PaymentDueDate>2026-11-10</cbc:PaymentDueDate></cac:PaymentTerms>',
    );
  });

  it('reparte en partes iguales y deja la diferencia de centavos en la última cuota', () => {
    const { summary } = client.prepareInvoice(credit([{ dueDate: '2026-11-10' }, { dueDate: '2026-12-10' }, { dueDate: '2027-01-10' }]));
    expect(summary.payment).toMatchObject({
      type: 'credit',
      netPending: '14.16',
      installments: [
        { number: 1, amount: '4.72' },
        { number: 2, amount: '4.72' },
        { number: 3, amount: '4.72' },
      ],
    });
    const sevenWays = client.prepareInvoice(credit(Array.from({ length: 7 }, (_, i) => ({ dueDate: `2026-12-${String(i + 1).padStart(2, '0')}` }))));
    const amounts = (sevenWays.summary.payment as { installments: Array<{ amount: string }> }).installments.map((i) => i.amount);
    expect(amounts).toEqual(['2.02', '2.02', '2.02', '2.02', '2.02', '2.02', '2.04']); // 6 × 2.02 + 2.04 = 14.16
  });

  it('acepta montos propios si suman el monto neto pendiente', () => {
    const { summary } = client.prepareInvoice(credit([{ dueDate: '2026-11-10', amount: 10 }, { dueDate: '2026-12-10', amount: 4.16 }]));
    expect(summary.payment).toMatchObject({ installments: [{ amount: '10.00' }, { amount: '4.16' }] });
  });

  it('un monto neto pendiente menor al total es válido; mayor, no (regla de SOL)', () => {
    expect(client.prepareInvoice(credit([{ dueDate: '2026-11-10' }], 10)).summary.payment).toMatchObject({ netPending: '10.00', installments: [{ amount: '10.00' }] });
    expect(issues(() => client.prepareInvoice(credit([{ dueDate: '2026-11-10' }], 100)))).toEqual([
      'payment.netPending: El monto neto pendiente (100.00) no puede ser mayor al importe total (14.16)',
    ]);
  });

  it('rechaza cuotas que no suman el monto pendiente y mezclas con/sin monto', () => {
    expect(issues(() => client.prepareInvoice(credit([{ dueDate: '2026-11-10', amount: 10 }])))).toEqual([
      'payment.installments: Las cuotas suman 10.00 y deben sumar el monto neto pendiente (14.16)',
    ]);
    expect(issues(() => client.prepareInvoice(credit([{ dueDate: '2026-11-10', amount: 10 }, { dueDate: '2026-12-10' }])))).toEqual([
      'payment.installments: Indica el monto en todas las cuotas o en ninguna (así se reparte en partes iguales)',
    ]);
  });

  it('el vencimiento debe ser posterior a la emisión (SUNAT rechaza con 3267 si es anterior o igual)', () => {
    // sampleInvoice emite el 2026-10-31 (hora de Lima).
    expect(issues(() => client.prepareInvoice(credit([{ dueDate: '2026-10-31' }])))).toEqual([
      'payment.installments.0.dueDate: El vencimiento (2026-10-31) debe ser posterior a la fecha de emisión (2026-10-31)',
    ]);
    expect(issues(() => client.prepareInvoice(credit([{ dueDate: '2026-10-01' }])))).not.toEqual([]);
    expect(issues(() => client.prepareInvoice(credit([{ dueDate: '2026-11-01' }])))).toEqual([]);
  });

  it('acepta cuotas con fechas desordenadas (SUNAT las acepta)', () => {
    expect(issues(() => client.prepareInvoice(credit([{ dueDate: '2026-12-10', amount: 10 }, { dueDate: '2026-11-10', amount: 4.16 }])))).toEqual([]);
  });

  it('valida las fechas y el máximo de 60 cuotas', () => {
    expect(issues(() => client.prepareInvoice(credit([{ dueDate: '2026-02-30' }])))).not.toEqual([]);
    expect(issues(() => client.prepareInvoice(credit([{ dueDate: '10/11/2026' }])))).not.toEqual([]);
    expect(issues(() => client.prepareInvoice(credit([])))).not.toEqual([]);
    const sixtyOne = Array.from({ length: 61 }, () => ({ dueDate: '2026-12-01' }));
    expect(issues(() => client.prepareInvoice(credit(sixtyOne)))).not.toEqual([]);
  });

  it('en dólares, las cuotas llevan la moneda de la factura', () => {
    const { signedXml } = client.prepareInvoice(sampleInvoice({ ...oneItem, currency: 'USD', payment: { type: 'credit', installments: [{ dueDate: '2026-11-10' }] } }));
    expect(signedXml).toContain('<cbc:PaymentMeansID>Cuota001</cbc:PaymentMeansID><cbc:Amount currencyID="USD">14.16</cbc:Amount>');
  });
});

describe('orden de compra y guías relacionadas', () => {
  it('escribe OrderReference y DespatchDocumentReference antes de la firma (orden UBL)', () => {
    const { signedXml, summary } = client.prepareInvoice(
      sampleInvoice({
        ...oneItem,
        purchaseOrder: '10194',
        relatedDespatches: [{ series: 't001', number: 15 }, { series: 'V001', number: 3, type: '31' }],
      }),
    );
    expect(signedXml).toContain('<cac:OrderReference><cbc:ID>10194</cbc:ID></cac:OrderReference>');
    expect(signedXml).toContain(
      '<cac:DespatchDocumentReference><cbc:ID>T001-15</cbc:ID><cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">09</cbc:DocumentTypeCode></cac:DespatchDocumentReference>',
    );
    expect(signedXml).toContain('<cac:DespatchDocumentReference><cbc:ID>V001-3</cbc:ID>');
    expect(signedXml.indexOf('<cac:OrderReference>')).toBeLessThan(signedXml.indexOf('<cac:DespatchDocumentReference>'));
    expect(signedXml.indexOf('<cac:DespatchDocumentReference>')).toBeLessThan(signedXml.indexOf('<cac:Signature>'));
    expect(summary.purchaseOrder).toBe('10194');
    expect(summary.relatedDespatches).toEqual([
      { type: '09', number: 'T001-15' },
      { type: '31', number: 'V001-3' },
    ]);
  });

  it('sin ellos, el XML no cambia', () => {
    const { signedXml, summary } = client.prepareInvoice(sampleInvoice(oneItem));
    expect(signedXml).not.toContain('OrderReference');
    expect(signedXml).not.toContain('DespatchDocumentReference');
    expect(summary.purchaseOrder).toBeUndefined();
    expect(summary.relatedDespatches).toEqual([]);
  });

  it('valida la orden de compra (máx. 20) y la serie de la guía', () => {
    expect(issues(() => client.prepareInvoice(sampleInvoice({ ...oneItem, purchaseOrder: 'X'.repeat(21) })))).not.toEqual([]);
    expect(issues(() => client.prepareInvoice(sampleInvoice({ ...oneItem, relatedDespatches: [{ series: 'T01', number: 1 }] })))).not.toEqual([]);
  });
});

describe.skipIf(!hasXmllint)('esquema UBL 2.1 oficial', () => {
  it('el XML de crédito con orden de compra y guías es válido', () => {
    const { signedXml } = client.prepareInvoice(
      sampleInvoice({
        ...oneItem,
        payment: { type: 'credit', installments: [{ dueDate: '2026-11-10' }, { dueDate: '2026-12-10' }] },
        purchaseOrder: '10194',
        relatedDespatches: [{ series: 'T001', number: 15 }],
      }),
    );
    const result = validateAgainstUbl(signedXml, 'Invoice');
    expect(result.errors).toBe('- validates');
    expect(result.valid).toBe(true);
  });
});
