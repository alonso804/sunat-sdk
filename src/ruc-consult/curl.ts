import { spawn, spawnSync } from 'node:child_process';

/** Ejecutable curl por plataforma: Windows lo incluye (`curl.exe`, TLS Schannel); macOS/Linux ya traen `curl`. */
const DEFAULT_EXECUTABLE = process.platform === 'win32' ? 'curl.exe' : 'curl';

export type CurlFetchOptions = {
  /** Ruta de curl. Por defecto el del sistema (`curl.exe` en Windows, `curl` en macOS/Linux). */
  executable?: string;
  /** Tiempo máximo de la consulta. Por defecto 30 s. */
  timeoutMs?: number;
};

let curlAvailable: boolean | undefined;

/** ¿Hay un curl utilizable? (`curl --version`); se comprueba la primera vez y luego queda en caché. */
export function isCurlAvailable(): boolean {
  if (curlAvailable === undefined) {
    const run = spawnSync(DEFAULT_EXECUTABLE, ['--version'], { encoding: 'buffer', timeout: 5_000, windowsHide: true });
    curlAvailable = run.status === 0;
  }
  return curlAvailable;
}

/**
 * Transporte `fetch`-compatible que ejecuta el `curl` del sistema (asíncrono: no bloquea el event loop).
 *
 * Contexto (verificado el 04/11/2026): SUNAT puso `e-consultaruc.sunat.gob.pe` detrás de Cloudflare, que desafía
 * (`cf-mitigated: challenge`, HTTP 403) según la huella TLS+HTTP del cliente: el `urllib` de Python y el `curl`
 * de Windows pasan; el TLS de Node (fetch, https, http2) recibe el desafío. `curlFetch` consulta con curl para
 * aprovechar esa huella: en Windows (Schannel, `curl.exe` incluido con el sistema) es la vía probada; en macOS y
 * Linux curl lleva OpenSSL y puede que siga el desafío — ahí la alternativa son las cookies de una sesión de
 * navegador (ver `RucConsultOptions.headers`).
 *
 * `consultRuc` ya lo usa como fallback automático ante el desafío (opción `curlFallback`); úsalo a mano solo si
 * quieres forzar el transporte curl desde la primera consulta. Lanza un proceso curl por consulta (con
 * `--max-time` según el timeout); tiene sentido para la consulta del RUC, no para los SOAP/REST con credenciales.
 */
export function curlFetch(options: CurlFetchOptions = {}): typeof fetch {
  const executable = options.executable ?? DEFAULT_EXECUTABLE;
  const timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
  const maxTime = Math.ceil(timeoutMs / 1000);

  return async function curl(url, init = {}) {
    // Mismas garantías que fetch: la URL se valida (una inválida lanza TypeError) y solo se admiten http y https.
    const target = new URL(url instanceof Request ? url.url : String(url));
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new TypeError(`curlFetch solo admite http y https, no ${target.protocol}`);
    }
    if (init.method !== undefined && !/^[A-Za-z]+$/.test(init.method)) {
      throw new TypeError(`Método HTTP inválido: ${init.method}`);
    }
    const headers = headerEntries(init);
    for (const [name, value] of headers) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value)) {
        throw new TypeError(`Cabecera inválida: ${name}`);
      }
    }
    const body = init.body === undefined || init.body === null ? undefined : String(init.body);

    // Para que curl trate todo como datos y no como su propia sintaxis:
    // -q (debe ir primero) ignora el .curlrc del usuario; --url hace que la URL nunca se lea como una opción;
    // --globoff desactiva los patrones [1-3] y {a,b}; --proto impide otros esquemas; y el cuerpo va por stdin
    // (--data-binary @-), así que un cuerpo que empiece con '@' no hace que curl lea un archivo local.
    const args = ['-q', '-sS', '-i', '--globoff', '--proto', '=http,https', '--url', target.href];
    args.push('--max-time', String(maxTime));
    if (init.method) args.push('-X', init.method);
    for (const [name, value] of headers) args.push('-H', `${name}: ${value}`);
    if (body !== undefined) args.push('--data-binary', '@-');

    return new Promise<Response>((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true });
      child.stdin?.on('error', () => undefined); // curl puede salir antes de leer el cuerpo (p. ej. un error de red)
      child.stdin?.end(body);
      const stdout: Buffer[] = [];
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr
        ?.setEncoding('utf8')
        .on('data', (chunk: string) => (stderr = stderr.length > 1_000 ? stderr : stderr + chunk));
      if (init.signal) init.signal.addEventListener('abort', () => child.kill(), { once: true });
      child.on('error', (error) => reject(new TypeError(`${executable}: ${error.message}`)));
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new TypeError(`${executable} salió con código ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
          return;
        }
        try {
          resolve(curlResponse(Buffer.concat(stdout)));
        } catch (error) {
          reject(error);
        }
      });
    });
  };
}

/** Separación entre el bloque de cabeceras (`curl -i`) y el cuerpo de la respuesta. */
const HEADER_BODY_GAP = '\r\n\r\n';

/** Nombres de cabecera en su mayúscula conocida: Cloudflare puntúa el estilo de la cabecera como navegador
 *  ( revision del 04/11/2026: nombres en minúscula — como los normaliza Headers de fetch — reciben el desafío). */
const CANONICAL_NAMES: Record<string, string> = {
  accept: 'Accept',
  'accept-language': 'Accept-Language',
  'content-type': 'Content-Type',
  'content-length': 'Content-Length',
  'user-agent': 'User-Agent',
  referer: 'Referer',
  host: 'Host',
  cookie: 'Cookie',
  connection: 'Connection',
  origin: 'Origin',
  'accept-encoding': 'Accept-Encoding',
  date: 'Date',
};

/** Canoniza el nombre de una cabecera (diccionario conocido; para lo demás, cada tramo con mayúscula). */
function canonicalName(name: string): string {
  return (
    CANONICAL_NAMES[name.toLowerCase()] ??
    name
      .split('-')
      .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1).toLowerCase() : part))
      .join('-')
  );
}

/** Cabeceras del init en el orden y la mayúscula en que quien llama las pasó (no pasa por `Headers`). */
function headerEntries(init: RequestInit): Array<[string, string]> {
  const headers = init.headers;
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers].map(([name, value]) => [canonicalName(name), value]);
  if (Array.isArray(headers)) return headers.map(([name, value]) => [canonicalName(name), String(value)]);
  return Object.entries(headers).map(([name, value]) => [canonicalName(name), String(value)]);
}

/** Convierte la salida de `curl -i` (línea de estado + cabeceras + cuerpo, en bytes) en una `Response`. */
function curlResponse(output: Buffer): Response {
  const gap = output.indexOf(HEADER_BODY_GAP, 0, 'latin1');
  if (gap === -1) throw new TypeError('La respuesta de curl no tiene bloque de cabeceras.');
  const head = output.subarray(0, gap).toString('latin1');
  const status = Number(/HTTP\/[\d.]+\s+(\d{3})/i.exec(head)?.[1] ?? 0);
  if (!status) throw new TypeError(`La respuesta de curl no se entiende: ${head.slice(0, 120)}`);
  const headers: Array<[string, string]> = [];
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return new Response(new Uint8Array(output.subarray(gap + HEADER_BODY_GAP.length)), { status, headers });
}
