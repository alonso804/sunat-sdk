/**
 * Juego de caracteres del texto libre que el SDK escribe en el XML: nombres, direcciones, descripciones, notas…
 * El XML siempre va en UTF-8; esta opción solo decide si ese texto se envía tal cual o se limita a Latin-1.
 * Es un objeto `as const` y a la vez un tipo con el mismo nombre: `TextCharset.latin1` es el valor y `TextCharset` la
 * unión de todos.
 */
export const TextCharset = {
  /**
   * Por defecto: el texto se envía tal cual. SUNAT acepta tildes, ñ, símbolos y caracteres fuera de Latin-1
   * (€, “ ”, —, Ω): verificado en beta el 04/11/2026, sin observaciones en el CDR.
   */
  unicode: 'unicode',
  /**
   * Cambia los caracteres fuera de Latin-1 (ISO-8859-1) por equivalentes simples (“ ” → ", — → -, … → ..., € → EUR) y
   * quita los que no tienen equivalente (Ω, emojis). Las tildes, la ñ y los símbolos de Latin-1 (½ ° « » ¿ ¡) no
   * cambian. Útil si un PDF que arma SUNAT (el de SOL, o el oficial de la guía) muestra "?" en esos caracteres.
   */
  latin1: 'latin1',
} as const;
export type TextCharset = (typeof TextCharset)[keyof typeof TextCharset];

/** Equivalentes de los caracteres tipográficos más comunes fuera de Latin-1 (los que suelen llegar al copiar y pegar). */
const REPLACEMENTS: Record<string, string> = {
  // Comillas y apóstrofos
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"',
  // Guiones y signo menos
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  // Viñetas
  '\u2022': '-', '\u2023': '-', '\u2043': '-',
  // Otros signos
  '\u2026': '...', '\u20AC': 'EUR', '\u2122': 'TM', '\u2116': 'No',
  // Espacios especiales → espacio; invisibles → nada
  '\u2002': ' ', '\u2003': ' ', '\u2007': ' ', '\u2009': ' ', '\u200A': ' ', '\u202F': ' ', '\u205F': ' ', '\u3000': ' ',
  '\u200B': '', '\u200C': '', '\u200D': '', '\u2060': '', '\uFEFF': '',
};

const isLatin1 = (text: string): boolean => [...text].every((char) => char.codePointAt(0)! <= 0xff);

/** Un carácter fuera de Latin-1 → su equivalente, o `''` si no tiene. */
function latin1Equivalent(char: string): string {
  const replacement = REPLACEMENTS[char];
  if (replacement !== undefined) return replacement;
  const compatible = char.normalize('NFKC'); // ancho completo, ligaduras, números en círculo…: "Ａ" → "A", "ﬁ" → "fi"
  if (isLatin1(compatible)) return compatible;
  const withoutMarks = char.normalize('NFKD').replace(/\p{M}/gu, ''); // letras con tilde de otros idiomas: "č" → "c"
  if (withoutMarks && isLatin1(withoutMarks)) return withoutMarks;
  return '';
}

/** Deja el texto en Latin-1: los caracteres de Latin-1 no cambian; los demás pasan por `latin1Equivalent`. */
export function toLatin1Text(text: string): string {
  let out = '';
  for (const char of text) out += char.codePointAt(0)! <= 0xff ? char : latin1Equivalent(char);
  return out;
}

/** Aplica `toLatin1Text` a todos los textos de un objeto de datos (objetos simples y arrays); el resto no cambia. */
export function toLatin1Deep<T>(value: T): T {
  if (typeof value === 'string') return toLatin1Text(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => toLatin1Deep(item)) as T;
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toLatin1Deep(item)])) as T;
  }
  return value; // números, fechas…
}
