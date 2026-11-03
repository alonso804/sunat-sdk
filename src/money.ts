import Decimal from 'decimal.js';

/**
 * Constructor de Decimal aislado (no modifica la configuración global de decimal.js
 * del proyecto que consuma este paquete).
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type Dec = Decimal;
export type Numeric = number | string | Decimal;

export function dec(value: Numeric): Dec {
  return new D(value);
}

/** Redondeo comercial (mitad hacia arriba) a `places` decimales. */
export function round(value: Dec, places: number): Dec {
  return value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
}

/** Monto con exactamente 2 decimales, como exige SUNAT para importes y totales. */
export function fmt2(value: Dec): string {
  return round(value, 2).toFixed(2);
}

/** Valor con exactamente `places` decimales (p. ej. peso bruto con 3). */
export function fmtFixed(value: Dec, places: number): string {
  return round(value, places).toFixed(places);
}

/**
 * Cantidad o precio unitario: hasta `max` decimales, sin ceros de relleno
 * pero con un mínimo de 2 decimales (SUNAT admite hasta 10 en precios y cantidades).
 */
export function fmtUpTo(value: Dec, max: number): string {
  const [int = '0', frac = ''] = round(value, max).toFixed(max).split('.');
  let trimmed = frac.replace(/0+$/, '');
  if (trimmed.length < 2) trimmed = trimmed.padEnd(2, '0');
  return `${int}.${trimmed}`;
}
