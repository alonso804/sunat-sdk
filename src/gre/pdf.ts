import { isSunatHttpsUrl } from '../cdr';
import { SunatApiError, SunatError, SunatTransportError, SunatValidationError } from '../errors';
import type { RetryOptions } from '../retry';

export type DespatchPdfOptions = {
  fetch?: typeof fetch;
  /**
   * Tiempo máximo por intento. Por defecto 10 s. Este servicio de SUNAT responde en menos de 1 s o se queda
   * colgado (verificado el 2026-11-01: 2 de 3 peticiones iguales respondieron bien y una no respondió en
   * 20 s), así que conviene cortar pronto y reintentar.
   */
  timeoutMs?: number;
  /**
   * Reintentos ante fallos de red, esperas agotadas o errores 408/429/5xx de SUNAT. Por defecto 4 reintentos con
   * pausas desde 0,5 s que se duplican: más y antes que en el resto del SDK, porque este servicio se cuelga a ratos.
   */
  retry?: RetryOptions;
};

export type DespatchPdf = {
  /** Contenido del PDF oficial que genera SUNAT. */
  pdf: Uint8Array;
  /** Nombre sugerido por SUNAT, p. ej. `20000000001-09-T001-15-PDF.pdf`, ya depurado. */
  fileName: string | undefined;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_REDIRECTS = 5;

/**
 * GET que sigue las redirecciones a mano y solo hacia URLs https de `*.sunat.gob.pe`: con el `redirect` por defecto,
 * `fetch` seguiría una redirección a cualquier dominio y el filtro de la URL inicial no serviría de nada.
 */
async function fetchWithinSunat(doFetch: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await doFetch(current, { method: 'GET', headers: { Accept: 'application/pdf' }, redirect: 'manual', signal });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) return response;
    const next = new URL(location, current).toString();
    if (!isSunatHttpsUrl(next)) {
      throw new SunatValidationError('SUNAT redirigió la descarga del PDF fuera de sunat.gob.pe; no se siguió.', [
        { path: 'qrUrl', message: `Redirección no permitida a ${new URL(next).host}` },
      ]);
    }
    current = next;
  }
  throw new SunatApiError(`Demasiadas redirecciones al descargar el PDF (más de ${MAX_REDIRECTS}).`, 310);
}

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
 * Por seguridad solo acepta URLs `https` de `*.sunat.gob.pe`, también en las redirecciones. No necesita credenciales;
 * si ya tienes un `SunatClient`, puedes usar su método `downloadDespatchPdf`, que reutiliza su `fetch` y su timeout.
 *
 * @param qrUrl - `cdr.qrUrl` de una guía aceptada.
 * @param options - `fetch` propio, tiempo máximo por intento (10 s por defecto) y reintentos ante fallos de red o 5xx
 *   (4 por defecto, con pausas que se duplican desde 0,5 s).
 * @returns El PDF (`pdf`) y el nombre de archivo que sugiere SUNAT (`fileName`), solo si es un nombre seguro.
 * @throws {SunatValidationError} Si la URL (o una redirección) no es https de sunat.gob.pe.
 * @throws {SunatApiError} Si SUNAT responde con un error (p. ej. 404) o con algo que no es un PDF.
 * @throws {SunatTransportError} Si la descarga falla por red tras los reintentos.
 *
 * @example
 * ```ts
 * const { pdf, fileName } = await downloadDespatchPdf(cdr.qrUrl!);
 * await writeFile(fileName ?? 'guia.pdf', pdf);
 * ```
 */
export async function downloadDespatchPdf(qrUrl: string, options: DespatchPdfOptions = {}): Promise<DespatchPdf> {
  if (!isSunatHttpsUrl(qrUrl)) {
    throw new SunatValidationError('La URL del QR debe ser https y de un dominio sunat.gob.pe.', [{ path: 'qrUrl', message: 'URL no permitida' }]);
  }
  const doFetch = options.fetch ?? fetch;
  const retries = Math.max(0, options.retry?.maxRetries ?? 4);
  const host = new URL(qrUrl).host;
  let delay = options.retry?.delayMs ?? 500;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(delay);
      delay *= 2;
    }
    let response: Response;
    try {
      response = await fetchWithinSunat(doFetch, qrUrl, options.timeoutMs ?? 10_000);
    } catch (cause) {
      if (cause instanceof SunatError) throw cause; // redirección no permitida: reintentar no cambia nada
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
