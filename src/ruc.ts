const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/**
 * Valida el formato de un RUC peruano: 11 dígitos, prefijo de tipo de contribuyente (10, 15, 16, 17 o 20) y dígito
 * verificador (módulo 11). No consulta a SUNAT: un RUC válido puede no existir o estar de baja.
 *
 * @param ruc - RUC como texto, sin espacios ni guiones.
 * @returns `true` si el formato y el dígito verificador son correctos.
 *
 * @example
 * ```ts
 * isValidRuc('20131312955'); // true
 * isValidRuc('20131312954'); // false (dígito verificador)
 * ```
 */
export function isValidRuc(ruc: string): boolean {
  if (!/^\d{11}$/.test(ruc)) return false;
  if (!['10', '15', '16', '17', '20'].includes(ruc.slice(0, 2))) return false;

  let sum = 0;
  for (let i = 0; i < WEIGHTS.length; i++) {
    sum += Number(ruc[i]) * (WEIGHTS[i] as number);
  }
  const check = (11 - (sum % 11)) % 10;
  return check === Number(ruc[10]);
}
