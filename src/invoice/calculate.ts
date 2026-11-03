import { AFFECTATIONS, IGV_RATE, type IgvAffectation } from '../catalogs';
import { D, dec, round, type Dec } from '../money';
import type { Invoice } from './schema';

export interface CalculatedLine {
  /** Número de línea, desde 1. */
  index: number;
  description: string;
  unit: string;
  productCode: string | undefined;
  quantity: Dec;
  /** Valor unitario SIN IGV (hasta 10 decimales). */
  unitValue: Dec;
  /** Precio unitario CON IGV (hasta 10 decimales). */
  unitPrice: Dec;
  affectation: IgvAffectation;
  /** Tasa aplicada: 0.18 para gravado, 0 para exonerado e inafecto. */
  rate: Dec;
  /** Valor de venta de la línea (sin IGV), 2 decimales. */
  lineValue: Dec;
  /** IGV de la línea, 2 decimales. */
  igv: Dec;
}

export interface CalculatedTotals {
  taxedBase: Dec;
  exoneratedBase: Dec;
  unaffectedBase: Dec;
  igv: Dec;
  /** Total valor de venta (sin IGV). */
  lineExtension: Dec;
  /** Total precio de venta (con IGV). */
  taxInclusive: Dec;
  /** Importe total a pagar. */
  payable: Dec;
  hasTaxed: boolean;
  hasExonerated: boolean;
  hasUnaffected: boolean;
}

export interface CalculatedInvoice {
  lines: CalculatedLine[];
  totals: CalculatedTotals;
}

export function calculateInvoice(invoice: Invoice): CalculatedInvoice {
  const igvRate = dec(IGV_RATE);

  const lines: CalculatedLine[] = invoice.items.map((item, i) => {
    const affectation = item.igvAffectation;
    const rate = AFFECTATIONS[affectation].taxed ? igvRate : new D(0);
    const factor = rate.plus(1);
    const quantity = dec(item.quantity);

    let unitValue: Dec;
    let unitPrice: Dec;
    if (item.unitValue !== undefined) {
      unitValue = dec(item.unitValue);
      unitPrice = round(unitValue.mul(factor), 10);
    } else {
      unitPrice = dec(item.unitPrice as number | string);
      unitValue = round(unitPrice.div(factor), 10);
    }

    const lineValue = round(quantity.mul(unitValue), 2);
    const igv = round(lineValue.mul(rate), 2);

    return {
      index: i + 1,
      description: item.description,
      unit: item.unit,
      productCode: item.productCode,
      quantity,
      unitValue,
      unitPrice,
      affectation,
      rate,
      lineValue,
      igv,
    };
  });

  const sumBase = (code: IgvAffectation): Dec =>
    lines.filter((l) => l.affectation === code).reduce((acc, l) => acc.plus(l.lineValue), new D(0));

  const taxedBase = sumBase('10');
  const exoneratedBase = sumBase('20');
  const unaffectedBase = sumBase('30');
  const igv = lines.reduce((acc, l) => acc.plus(l.igv), new D(0));
  const lineExtension = taxedBase.plus(exoneratedBase).plus(unaffectedBase);
  const taxInclusive = lineExtension.plus(igv);

  return {
    lines,
    totals: {
      taxedBase,
      exoneratedBase,
      unaffectedBase,
      igv,
      lineExtension,
      taxInclusive,
      payable: taxInclusive,
      hasTaxed: lines.some((l) => l.affectation === '10'),
      hasExonerated: lines.some((l) => l.affectation === '20'),
      hasUnaffected: lines.some((l) => l.affectation === '30'),
    },
  };
}
