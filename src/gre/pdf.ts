import { isSunatHttpsUrl } from '../cdr';
import { SunatApiError, SunatTransportError, SunatValidationError } from '../errors';

export interface DespatchPdfOptions {
  fetch?: typeof fetch;
  /**
   * Tiempo máximo por intento. Por defecto 10 s. Este servicio de SUNAT responde en menos de 1 s o se queda
   * colgado (verificado el 2026-11-01: 2 de 3 peticiones iguales respondieron bien y una no respondió en
   * 20 s), así que conviene cortar pronto y reintentar.
   */
  timeoutMs?: number;
  /** Reintentos ante fallos de red, esperas agotadas o errores 408/429/5xx de SUNAT. Por defecto 4. */
  retries?: number;
  /** Pausa entre reintentos. Por defecto 0,5 s, y se duplica en cada uno. */
  retryDelayMs?: number;
}

export interface DespatchPdf {
  /** Contenido del PDF oficial que genera SUNAT. */
  pdf: Uint8Array;
  /** Nombre sugerido por SUNAT, p. ej. `20000000001-09-T001-15-PDF.pdf`, ya depurado. */
  fileName: string | undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Nombre de archivo de la cabecera `Content-Disposition`, solo si es seguro (letras, números, `.`, `_`, `-`). */
function fileNameFrom(header: string | null): string | undefined {
  const match = header ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header) : null;
  const name = match?.[1]?.trim();
  return name && /^[A-Za-z0-9._-]{1,120}$/.test(name) ? name : undefined;
}

/**
 * Descarga el PDF oficial de una guía de remisión desde la URL del QR (`cdr.qrUrl`). Es la misma dirección
 * que abre el QR impreso: SUNAT la responde con un archivo PDF (no con una página), por eso al escanearla con
 * el teléfono "se descarga" el PDF.
 *
 * Por seguridad solo acepta URLs `https` de `*.sunat.gob.pe`.
 */
export async function downloadDespatchPdf(qrUrl: string, options: DespatchPdfOptions = {}): Promise<DespatchPdf> {
  if (!isSunatHttpsUrl(qrUrl)) {
    throw new SunatValidationError('La URL del QR debe ser https y de un dominio sunat.gob.pe.', [{ path: 'qrUrl', message: 'URL no permitida' }]);
  }
  const doFetch = options.fetch ?? fetch;
  const retries = Math.max(0, options.retries ?? 4);
  const host = new URL(qrUrl).host;
  let delay = options.retryDelayMs ?? 500;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(delay);
      delay *= 2;
    }
    let response: Response;
    try {
      response = await doFetch(qrUrl, { method: 'GET', headers: { Accept: 'application/pdf' }, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    } catch (cause) {
      lastError = new SunatTransportError(`No se pudo contactar a ${host} para descargar el PDF.`, { cause });
      continue;
    }

    if (!response.ok) {
      lastError = new SunatApiError(`SUNAT no entregó el PDF (HTTP ${response.status}).`, response.status);
      if ((lastError as SunatApiError).retryable) continue;
      throw lastError;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    // Un PDF empieza con "%PDF-". Se comprueba el contenido y no solo la cabecera, por si llega una página de error.
    const isPdf = bytes.length > 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
    if (!isPdf) {
      throw new SunatApiError('SUNAT respondió, pero el contenido no es un PDF.', response.status, undefined, [], Buffer.from(bytes.subarray(0, 300)).toString('utf8'));
    }
    return { pdf: bytes, fileName: fileNameFrom(response.headers.get('content-disposition')) };
  }
  throw lastError ?? new SunatTransportError('No se pudo descargar el PDF.');
}
