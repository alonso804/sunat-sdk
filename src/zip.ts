import { strToU8, unzipSync, zipSync } from 'fflate';

/** Comprime un único archivo en un ZIP (formato que SUNAT exige para enviar comprobantes). */
export function zipSingleFile(fileName: string, content: string | Uint8Array): Uint8Array {
  const data = typeof content === 'string' ? strToU8(content) : content;
  return zipSync({ [fileName]: data }, { level: 6 });
}

/** Descomprime un ZIP en memoria y devuelve sus archivos por nombre. */
export function unzipFiles(zip: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(zip);
}
