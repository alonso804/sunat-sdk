import type { Currency } from './catalogs';
import { type Dec, round } from './money';

const UNITS = [
  '',
  'UNO',
  'DOS',
  'TRES',
  'CUATRO',
  'CINCO',
  'SEIS',
  'SIETE',
  'OCHO',
  'NUEVE',
  'DIEZ',
  'ONCE',
  'DOCE',
  'TRECE',
  'CATORCE',
  'QUINCE',
  'DIECISEIS',
  'DIECISIETE',
  'DIECIOCHO',
  'DIECINUEVE',
  'VEINTE',
  'VEINTIUNO',
  'VEINTIDOS',
  'VEINTITRES',
  'VEINTICUATRO',
  'VEINTICINCO',
  'VEINTISEIS',
  'VEINTISIETE',
  'VEINTIOCHO',
  'VEINTINUEVE',
];
const TENS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const HUNDREDS = [
  '',
  'CIENTO',
  'DOSCIENTOS',
  'TRESCIENTOS',
  'CUATROCIENTOS',
  'QUINIENTOS',
  'SEISCIENTOS',
  'SETECIENTOS',
  'OCHOCIENTOS',
  'NOVECIENTOS',
];

/** 1..999 */
function belowThousand(n: number): string {
  if (n === 100) return 'CIEN';
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(HUNDREDS[hundreds] ?? '');
  if (rest > 0) {
    if (rest < 30) {
      parts.push(UNITS[rest] ?? '');
    } else {
      const tens = Math.floor(rest / 10);
      const unit = rest % 10;
      parts.push(unit === 0 ? (TENS[tens] ?? '') : `${TENS[tens]} Y ${UNITS[unit]}`);
    }
  }
  return parts.join(' ');
}

/** "UNO" -> "UN" delante de MIL / MILLON(ES): "VEINTIUN MIL", "TREINTA Y UN MILLONES". */
function apocopate(words: string): string {
  return words.replace(/UNO$/, 'UN');
}

function convert(n: number): string {
  if (n === 0) return '';
  if (n < 1000) return belowThousand(n);
  if (n < 1_000_000) {
    const thousands = Math.floor(n / 1000);
    const rest = n % 1000;
    const head = thousands === 1 ? 'MIL' : `${apocopate(convert(thousands))} MIL`;
    return rest ? `${head} ${belowThousand(rest)}` : head;
  }
  const millions = Math.floor(n / 1_000_000);
  const rest = n % 1_000_000;
  const head = millions === 1 ? 'UN MILLON' : `${apocopate(convert(millions))} MILLONES`;
  return rest ? `${head} ${convert(rest)}` : head;
}

/** Entero (0 <= n < 1e12) en letras mayúsculas, sin tildes. */
export function integerToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e12) {
    throw new RangeError(`Entero fuera de rango para convertir a letras: ${n}`);
  }
  return n === 0 ? 'CERO' : convert(n);
}

const CURRENCY_NAMES = {
  PEN: 'SOLES',
  USD: 'DOLARES AMERICANOS',
} as const satisfies Record<Currency, string>;

/**
 * Leyenda 1000 de SUNAT ("monto en letras"):
 * `SON: CIENTO DIECIOCHO CON 00/100 SOLES`
 */
export function amountInWords(amount: Dec, currency: Currency): string {
  const rounded = round(amount, 2);
  const cents = rounded.mul(100).mod(100).toNumber();
  const integer = rounded.floor().toNumber();
  const centsText = String(cents).padStart(2, '0');
  return `SON: ${integerToWords(integer)} CON ${centsText}/100 ${CURRENCY_NAMES[currency]}`;
}
