import { SunatApiError, SunatTransportError } from './errors';

/** Reintentos automáticos ante fallos pasajeros de SUNAT (ver `SunatClientConfig.retry`). */
export type RetryOptions = {
  /** Reintentos después del primer intento. Por defecto 3; `0` los desactiva. */
  maxRetries?: number;
  /** Pausa antes del primer reintento; se duplica en cada uno (1 s, 2 s, 4 s…). Por defecto 1000 ms. */
  delayMs?: number;
};

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_DELAY_MS = 1_000;

/**
 * Códigos de Node/undici que indican que la conexión no llegó a abrirse: la petición nunca salió.
 * (Un corte con la petición ya enviada llega como `UND_ERR_SOCKET` o como espera agotada, y NO está aquí.)
 */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function failedToConnect(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; cause && depth < 5; depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_SENT_CODES.has(code)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Para ENVÍOS (sendBill, envío de una GRE): solo los fallos que SUNAT con seguridad no procesó, así que reenviar el
 * mismo documento no puede duplicarlo ni cambiar su resultado.
 * - HTTP 401, 429 o 503 sin respuesta de SUNAT: el proxy rechazó la petición antes de procesarla (responde 401 cuando
 *   recibe peticiones muy seguidas).
 * - La conexión no llegó a abrirse (DNS, conexión rechazada, sin ruta).
 *
 * Un corte o una espera agotada con la petición ya enviada NO se reintenta: SUNAT pudo haberla procesado, y quien
 * llama debe consultar el estado antes de reenviar.
 */
export function isSafeToResend(error: unknown): boolean {
  if (error instanceof SunatTransportError) {
    const status = error.httpStatus;
    return status === undefined ? failedToConnect(error) : status === 401 || status === 429 || status === 503;
  }
  if (error instanceof SunatApiError) return error.status === 429 || error.status === 503;
  return false;
}

/** Para LECTURAS sin efecto (token, consulta de CDR o de ticket): cualquier fallo pasajero. */
export function isRetryableRead(error: unknown): boolean {
  return (error instanceof SunatTransportError || error instanceof SunatApiError) && error.retryable;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ejecuta `call` y la repite, con pausas crecientes y un tope, mientras el error cumpla `shouldRetry`. */
export async function withRetries<T>(
  call: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  options: RetryOptions = {},
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
  let delay = Math.max(0, options.delayMs ?? DEFAULT_DELAY_MS);
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetry(error)) throw error;
    }
    await sleep(delay);
    delay *= 2;
  }
}
