import { describe, expect, it } from 'vitest';
import { dec } from '../src/money';
import { amountInWords, integerToWords } from '../src/amount-in-words';

describe('integerToWords', () => {
  it.each([
    [0, 'CERO'],
    [1, 'UNO'],
    [15, 'QUINCE'],
    [21, 'VEINTIUNO'],
    [30, 'TREINTA'],
    [45, 'CUARENTA Y CINCO'],
    [100, 'CIEN'],
    [101, 'CIENTO UNO'],
    [118, 'CIENTO DIECIOCHO'],
    [500, 'QUINIENTOS'],
    [1000, 'MIL'],
    [1021, 'MIL VEINTIUNO'],
    [2100, 'DOS MIL CIEN'],
    [21_000, 'VEINTIUN MIL'],
    [31_000, 'TREINTA Y UN MIL'],
    [101_000, 'CIENTO UN MIL'],
    [999_999, 'NOVECIENTOS NOVENTA Y NUEVE MIL NOVECIENTOS NOVENTA Y NUEVE'],
    [1_000_000, 'UN MILLON'],
    [1_001_000, 'UN MILLON MIL'],
    [1_001_001, 'UN MILLON MIL UNO'],
    [2_000_000, 'DOS MILLONES'],
    [31_000_000, 'TREINTA Y UN MILLONES'],
  ])('%i → %s', (n, words) => {
    expect(integerToWords(n)).toBe(words);
  });

  it('rechaza valores fuera de rango', () => {
    expect(() => integerToWords(-1)).toThrow(RangeError);
    expect(() => integerToWords(1.5)).toThrow(RangeError);
  });
});

describe('amountInWords (leyenda 1000)', () => {
  it('formatea soles con céntimos', () => {
    expect(amountInWords(dec('118'), 'PEN')).toBe('SON: CIENTO DIECIOCHO CON 00/100 SOLES');
    expect(amountInWords(dec('1234.56'), 'PEN')).toBe('SON: MIL DOSCIENTOS TREINTA Y CUATRO CON 56/100 SOLES');
    expect(amountInWords(dec('0.05'), 'PEN')).toBe('SON: CERO CON 05/100 SOLES');
  });

  it('formatea dólares', () => {
    expect(amountInWords(dec('413'), 'USD')).toBe('SON: CUATROCIENTOS TRECE CON 00/100 DOLARES AMERICANOS');
  });

  it('redondea a 2 decimales', () => {
    expect(amountInWords(dec('10.005'), 'PEN')).toBe('SON: DIEZ CON 01/100 SOLES');
  });
});
