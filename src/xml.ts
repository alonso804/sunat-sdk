import { SUNAT_TIME_ZONE } from './config';

/** Id del elemento ds:Signature; `cac:Signature` lo referencia mediante `#<id>`. */
export const SIGNATURE_ID = 'SignatureSP';

// Caracteres de control no permitidos en XML 1.0 (se conservan \t, \n y \r).
// biome-ignore lint/suspicious/noControlCharactersInRegex: busca justamente esos caracteres para quitarlos del XML.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Escapa texto o valores de atributos para insertarlos en XML. */
export function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Texto libre en una sola línea y sin espacios repetidos (SUNAT rechaza saltos de línea y tabulaciones). */
export function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Fecha (YYYY-MM-DD) y hora (HH:mm:ss) en hora de Lima. */
export function limaDateTime(date: Date): { date: string; time: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: SUNAT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}
