import { isSunatHttpsUrl } from './cdr';
import { SunatTransportError } from './errors';

const MAX_REDIRECTS = 3;

/** Las únicas redirecciones con las que `fetch` mantiene el método y el cuerpo. */
const KEEPS_METHOD_AND_BODY = new Set([307, 308]);

/**
 * `fetch` para las peticiones que llevan credenciales: la clave SOL en el sobre SOAP, `client_secret` y la clave SOL
 * en el formulario del token, y el Bearer en la API de guías.
 *
 * Con el `redirect` por defecto, `fetch` seguiría un 307/308 a cualquier destino y reenviaría el cuerpo con la clave,
 * incluso a `http` o a otro dominio. Aquí las redirecciones se siguen a mano y solo hacia `https` de `*.sunat.gob.pe`
 * o hacia el mismo origen de la petición (un simulador o un proxy configurado a propósito). Cualquier otra se corta
 * con `SunatTransportError` sin enviar nada al nuevo destino. Una redirección 301/302/303 de un POST también se corta:
 * `fetch` la convertiría en un GET sin cuerpo, que fallaría de todos modos.
 */
export async function fetchWithCredentials(doFetch: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const origin = new URL(url).origin;
  const method = (init.method ?? 'GET').toUpperCase();
  let current = url;
  for (let hop = 0; ; hop++) {
    const response = await doFetch(current, { ...init, redirect: 'manual' });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) return response;
    await response.body?.cancel().catch(() => undefined);

    const next = new URL(location, current);
    const where = `${next.protocol}//${next.host}`;
    if (hop >= MAX_REDIRECTS) {
      throw new SunatTransportError(`SUNAT redirigió más de ${MAX_REDIRECTS} veces; no se siguió.`, {
        httpStatus: response.status,
      });
    }
    if (!isSunatHttpsUrl(next.href) && next.origin !== origin) {
      throw new SunatTransportError(
        `SUNAT redirigió la petición a ${where}, fuera de https://*.sunat.gob.pe; no se siguió para no reenviar las credenciales.`,
        { httpStatus: response.status },
      );
    }
    if (method !== 'GET' && !KEEPS_METHOD_AND_BODY.has(response.status)) {
      throw new SunatTransportError(
        `SUNAT respondió ${response.status} (redirección a ${where}) a un ${method}; no se siguió porque se perdería el cuerpo.`,
        { httpStatus: response.status },
      );
    }
    current = next.href;
  }
}
