import { describe, expect, it } from 'vitest';
import { calculateInvoice } from '../src/invoice/calculate';
import { InvoiceSchema } from '../src/invoice/schema';
import { fmt2, fmtUpTo, dec } from '../src/money';
import { isValidRuc } from '../src/ruc';
import { sampleInvoice } from './helpers';

const calc = (overrides = {}) => calculateInvoice(InvoiceSchema.parse(sampleInvoice(overrides)));

describe('isValidRuc', () => {
  it('acepta RUC con dígito verificador correcto', () => {
    expect(isValidRuc('20000000001')).toBe(true);
    expect(isValidRuc('20131312955')).toBe(true);
  });

  it('rechaza formatos y dígitos verificadores incorrectos', () => {
    expect(isValidRuc('20000000002')).toBe(false);
    expect(isValidRuc('30000000001')).toBe(false);
    expect(isValidRuc('2000000001')).toBe(false);
    expect(isValidRuc('abcdefghijk')).toBe(false);
  });
});

describe('formato numérico', () => {
  it('fmt2 siempre usa 2 decimales', () => {
    expect(fmt2(dec('5'))).toBe('5.00');
    expect(fmt2(dec('1.005'))).toBe('1.01');
  });

  it('fmtUpTo recorta ceros pero deja al menos 2 decimales', () => {
    expect(fmtUpTo(dec('5'), 10)).toBe('5.00');
    expect(fmtUpTo(dec('8.4745762711864'), 10)).toBe('8.4745762712');
    expect(fmtUpTo(dec('2.5'), 10)).toBe('2.50');
  });
});

describe('calculateInvoice', () => {
  it('calcula una factura con precios que incluyen IGV', () => {
    const { lines, totals } = calc();
    expect(lines.map((l) => [fmt2(l.lineValue), fmt2(l.igv)])).toEqual([
      ['250.00', '45.00'],
      ['100.00', '18.00'],
    ]);
    expect(fmt2(totals.taxedBase)).toBe('350.00');
    expect(fmt2(totals.igv)).toBe('63.00');
    expect(fmt2(totals.payable)).toBe('413.00');
  });

  it('redondea por línea cuando el precio no divide exacto', () => {
    const { lines, totals } = calc({ items: [{ description: 'TORNILLO', quantity: 3, unitPrice: 10 }] });
    const [line] = lines;
    expect(fmtUpTo(line!.unitValue, 10)).toBe('8.4745762712');
    expect(fmt2(line!.lineValue)).toBe('25.42');
    expect(fmt2(line!.igv)).toBe('4.58');
    expect(fmt2(totals.payable)).toBe('30.00');
  });

  it('acepta valor unitario sin IGV y deriva el precio con IGV', () => {
    const { lines, totals } = calc({ items: [{ description: 'SERVICIO', quantity: 1, unitValue: 100 }] });
    expect(fmt2(lines[0]!.unitPrice)).toBe('118.00');
    expect(fmt2(totals.payable)).toBe('118.00');
  });

  it('separa operaciones gravadas, exoneradas e inafectas', () => {
    const { totals } = calc({
      items: [
        { description: 'GRAVADO', quantity: 1, unitPrice: 118 },
        { description: 'EXONERADO', quantity: 1, unitPrice: 50, igvAffectation: '20' },
        { description: 'INAFECTO', quantity: 2, unitPrice: 5, igvAffectation: '30' },
      ],
    });
    expect(fmt2(totals.taxedBase)).toBe('100.00');
    expect(fmt2(totals.exoneratedBase)).toBe('50.00');
    expect(fmt2(totals.unaffectedBase)).toBe('10.00');
    expect(fmt2(totals.igv)).toBe('18.00');
    expect(fmt2(totals.payable)).toBe('178.00');
  });
});

describe('InvoiceSchema', () => {
  it('rechaza serie que no empieza con F', () => {
    expect(InvoiceSchema.safeParse(sampleInvoice({ series: 'B001' })).success).toBe(false);
  });

  it('rechaza ítems sin precio o con ambos precios', () => {
    const none = sampleInvoice({ items: [{ description: 'X', quantity: 1 }] });
    const both = sampleInvoice({ items: [{ description: 'X', quantity: 1, unitPrice: 1, unitValue: 1 }] });
    expect(InvoiceSchema.safeParse(none).success).toBe(false);
    expect(InvoiceSchema.safeParse(both).success).toBe(false);
  });

  it('rechaza cantidades en cero y RUC de cliente inválido', () => {
    expect(InvoiceSchema.safeParse(sampleInvoice({ items: [{ description: 'X', quantity: 0, unitPrice: 1 }] })).success).toBe(false);
    expect(
      InvoiceSchema.safeParse(sampleInvoice({ customer: { ruc: '20000000002', name: 'X' } })).success,
    ).toBe(false);
  });
});
