import { isSunatHttpsUrl } from '../cdr';
import { SunatApiError, SunatError, SunatTransportError, SunatValidationError } from '../errors';
import type { RetryOptions } from '../retry';

/** Opciones de la función `downloadDespatchPdf` (el método de `SunatClient` toma `fetch` y `timeoutMs` del cliente). */
export type DespatchPdfOptions = {
  /** Para pruebas o proxies. Por defecto el `fetch` global. */
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

/** PDF oficial de una guía, tal como lo entrega SUNAT. */
export type DespatchPdf = {
  /** Contenido del PDF oficial que genera SUNAT. */
  pdf: Uint8Array;
  /** Nombre sugerido por SUNAT, p. ej. `20000000001-09-T001-15-PDF.pdf`, ya depurado. */
  fileName: string | undefined;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_REDIRECTS = 5;

/** Dónde publica SUNAT el PDF de una GRE: es la URL que trae el CDR (`cdr.qrUrl`) y la que codifica el QR. */
const QR_HOST = 'e-factura.sunat.gob.pe';
const QR_PATH = '/v1/contribuyente/gre/comprobantes/descargaqr';

/**
 * Tope de bytes del PDF. El de una guía pesa decenas de KB; el tope solo evita cargar en memoria una respuesta
 * enorme (se corta apenas lo supera, sin leer el resto).
 */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Bytes del comienzo de una respuesta que no es PDF que se guardan en el error para diagnosticar. */
const RAW_BODY_PREVIEW = 300;

const PDF_MAGIC = '%PDF-';

/**
 * ¿Es la URL del QR tal como la entrega SUNAT en el CDR de una GRE? Exige https, el host y la ruta del servicio
 * de descarga (sin puerto ni usuario) y un `hashqr`. Así se rechaza cualquier otra dirección de sunat.gob.pe.
 */
function isDespatchQrUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === QR_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === QR_PATH &&
    Boolean(url.searchParams.get('hashqr'))
  );
}

/**
 * GET que sigue las redirecciones a mano y solo hacia URLs https de `*.sunat.gob.pe`: con el `redirect` por defecto,
 * `fetch` seguiría una redirección a cualquier dominio y el filtro de la URL inicial no serviría de nada.
 */
async function fetchWithinSunat(doFetch: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await doFetch(current, {
      method: 'GET',
      headers: { Accept: 'application/pdf' },
      redirect: 'manual',
      signal,
    });
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

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const startsWithPdfMagic = (bytes: Uint8Array): boolean =>
  bytes.length >= PDF_MAGIC.length && Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString('latin1') === PDF_MAGIC;

/**
 * Lee el cuerpo por partes, con tope de bytes. Un PDF empieza con "%PDF-": se comprueba el contenido y no solo la
 * cabecera, por si llega una página de error, y si no lo es se deja de leer tras los primeros bytes.
 * Los errores de red al leer se propagan tal cual (el llamador los reintenta); los de contenido son `SunatApiError`.
 */
async function readPdfBody(response: Response): Promise<Uint8Array> {
  const tooLarge = () =>
    new SunatApiError(
      `El PDF supera el tamaño máximo de ${MAX_PDF_BYTES / 1024 / 1024} MB; se cortó la descarga.`,
      response.status,
    );
  if (Number(response.headers.get('content-length')) > MAX_PDF_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  let isPdf: boolean | undefined; // se sabe al tener los primeros bytes
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > MAX_PDF_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    if (isPdf === undefined && size >= PDF_MAGIC.length) isPdf = startsWithPdfMagic(concat(chunks, size));
    if (isPdf === false && size >= RAW_BODY_PREVIEW) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }

  const bytes = concat(chunks, size);
  if (!isPdf || bytes.length <= PDF_MAGIC.length) {
    throw new SunatApiError(
      'SUNAT respondió, pero el contenido no es un PDF.',
      response.status,
      undefined,
      [],
      Buffer.from(bytes.subarray(0, RAW_BODY_PREVIEW)).toString('utf8'),
    );
  }
  return bytes;
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
 * Pásale la `cdr.qrUrl` que guardaste al emitir, no una URL que llegue de tus usuarios. Por seguridad solo acepta
 * esa forma de URL (`https://e-factura.sunat.gob.pe/v1/contribuyente/gre/comprobantes/descargaqr?hashqr=…`), sigue
 * redirecciones solo a https de `*.sunat.gob.pe` y lee como máximo 10 MB. No necesita credenciales; si ya tienes un
 * `SunatClient`, puedes usar su método `downloadDespatchPdf`, que reutiliza su `fetch` y su timeout.
 *
 * @param qrUrl - `cdr.qrUrl` de una guía aceptada.
 * @param options - `fetch` propio, tiempo máximo por intento (10 s por defecto) y reintentos ante fallos de red o 5xx
 *   (4 por defecto, con pausas que se duplican desde 0,5 s).
 * @returns El PDF (`pdf`) y el nombre de archivo que sugiere SUNAT (`fileName`), solo si es un nombre seguro.
 * @throws {SunatValidationError} Si la URL no es la del QR de una GRE o una redirección sale de https de sunat.gob.pe.
 * @throws {SunatApiError} Si SUNAT responde con un error (p. ej. 404), con algo que no es un PDF o con más de 10 MB.
 * @throws {SunatTransportError} Si la descarga falla por red tras los reintentos.
 *
 * @example
 * ```ts
 * const { pdf, fileName } = await downloadDespatchPdf(cdr.qrUrl!);
 * await writeFile(fileName ?? 'guia.pdf', pdf);
 * ```
 */
export async function downloadDespatchPdf(qrUrl: string, options: DespatchPdfOptions = {}): Promise<DespatchPdf> {
  if (!isDespatchQrUrl(qrUrl)) {
    throw new SunatValidationError(
      `La URL no es la del QR de una guía: debe ser la cdr.qrUrl que entrega SUNAT (https://${QR_HOST}${QR_PATH}?hashqr=…).`,
      [{ path: 'qrUrl', message: 'URL no permitida' }],
    );
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

    let pdf: Uint8Array;
    try {
      pdf = await readPdfBody(response);
    } catch (cause) {
      if (cause instanceof SunatError) throw cause; // no es un PDF o es demasiado grande: reintentar no cambia nada
      lastError = new SunatTransportError(`Se cortó la descarga del PDF desde ${host}.`, { cause });
      continue;
    }
    return { pdf, fileName: fileNameFrom(response.headers.get('content-disposition')) };
  }
  throw lastError ?? new SunatTransportError('No se pudo descargar el PDF.');
}
