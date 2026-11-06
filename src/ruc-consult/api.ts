import { SunatApiError, SunatTransportError, SunatValidationError } from '../errors';
import { isRetryableRead, type RetryOptions, withRetries } from '../retry';
import { isValidRuc } from '../ruc';
import { curlFetch, isCurlAvailable } from './curl';
import { parseRucPage, type RucConsultResult, RucPageError } from './parse';

/** Opciones de `consultRuc`. */
export type RucConsultOptions = {
  /** Para pruebas o proxies. Por defecto el `fetch` global. */
  fetch?: typeof fetch;
  /** Tiempo máximo por intento. Por defecto 30 s (lo que usaba la lógica de referencia). */
  timeoutMs?: number;
  /**
   * Reintentos ante fallos pasajeros (red, 408/429/5xx) y páginas que no se pueden interpretar (una SUNAT saturada
   * a veces responde con algo que no es un resultado). Por defecto 3, con pausas de 1 s, 2 s y 4 s, igual que el resto
   * del SDK; `{ maxRetries: 0 }` los desactiva.
   */
  retry?: RetryOptions;
  /** Diagnóstico (calibrar el parseo): intercepta la página HTML que SUNAT entregó. */
  onPage?: (page: string) => void;
  /** Cabeceras extra, fusionadas sobre las por defecto (los nombres quedan tal como los escribas). Nota del
   *  04/11/2026: las cookies de un navegador (incluso `cf_clearance` fresco) no bastan desde el TLS de Node —
   *  Cloudflare ata el desafío a la huella del cliente (IP + TLS/HTTP), no a la cookie; útiles solo en clientes
   *  cuya huella ya pasa (p. ej. transporte curl en otro runtime con huella reconocida). */
  headers?: Record<string, string>;
  /**
   * Fallback automático ante el desafío anti-bot: si el `fetch` por defecto recibe la respuesta 403 de Cloudflare,
   * se reintenta una vez con `curlFetch()` (el curl del sistema; en Windows es la vía probada, y Cloudflare no lo
   * desafía). `true` por defecto. Se ignora si pasas un `fetch` propio (respetamos el transporte que elijas) y no
   * aplica si el sistema no tiene curl.
   */
  curlFallback?: boolean;
};

const RUC_CONSULT_URL = 'https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/jcrS00Alias';
const RUC_CONSULT_REFERER = 'https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/FrameCriterioBusquedaWeb.jsp';
/** Cabeceras con las que el formulario hace su POST (navegador, sin cookies). */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Referer: RUC_CONSULT_REFERER,
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
};

/**
 * Código de un `SunatApiError` cuando SUNAT responde con un desafío anti-bot (Cloudflare, «Just a moment»):
 * la consulta no se completó y reintentar la empeora, así que `consultRuc` no lo reintenta.
 */
export const CHALLENGE_CODE = 'desafio-antibot';

const DEFAULT_TIMEOUT_MS = 30_000;

const RECAPTCHA_TOKEN_LENGTH = 52;
const RECAPTCHA_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * El formulario pide un token de reCAPTCHA; al 02/11/2026 (fecha de la lógica de referencia, `consulta_sunat.py`)
 * SUNAT no lo validaba y aceptaba cualquier texto aleatorio de 52 caracteres, sin cookies.
 */
function fakeRecaptchaToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RECAPTCHA_TOKEN_LENGTH));
  let token = '';
  for (const byte of bytes) token += RECAPTCHA_TOKEN_ALPHABET[byte % RECAPTCHA_TOKEN_ALPHABET.length]!;
  return token;
}

/** Los campos son los del formulario web (el mismo POST que hace la página al buscar por RUC). */
function consultRucForm(ruc: string): URLSearchParams {
  return new URLSearchParams({
    accion: 'consPorRuc',
    razSoc: '',
    nroRuc: ruc,
    nrodoc: '',
    token: fakeRecaptchaToken(),
    contexto: 'ti-it',
    modo: '1',
    rbtnTipo: '1',
    search1: ruc,
    tipdoc: '1',
    search2: '',
    search3: '',
    codigo: '',
  });
}

/** La página va en ISO-8859-1: si el encabezado no trae charset, el navegador la decodifica como windows-1252. */
function decodeResponse(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType ?? '')?.[1] ?? 'windows-1252';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes); // etiqueta desconocida en esta plataforma
  }
}

async function fetchRucPage(ruc: string, options: RucConsultOptions): Promise<RucConsultResult> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(RUC_CONSULT_URL, {
      method: 'POST',
      headers: { ...BROWSER_HEADERS, ...(options.headers ?? {}) },
      body: consultRucForm(ruc).toString(),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new SunatTransportError('No se pudo contactar a SUNAT para consultar el RUC.', { cause });
  }
  const page = decodeResponse(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-type'));
  if (!response.ok) {
    const challenge = response.headers.get('cf-mitigated') === 'challenge' || page.includes('Just a moment');
    if (challenge) {
      throw new SunatApiError(
        `SUNAT respondió HTTP ${response.status} con un desafío anti-bot de Cloudflare ("Just a moment"): la consulta no se ` +
          'completó. Con `curlFallback` activo se espera con el reintento vía curl del sistema; si el SO no trae curl ' +
          '(`apt install curl` / `apk add curl` / `dnf install curl`), o el desafío también supera a curl, el detalle ' +
          'está en README "Anti-bot" (las cookies de navegador no bastan: el desafío va atado a la huella del cliente).',
        response.status,
        CHALLENGE_CODE,
        [],
        page.slice(0, 1_000),
      );
    }
    throw new SunatApiError(
      `SUNAT respondió HTTP ${response.status} en la consulta del RUC.`,
      response.status,
      undefined,
      [],
      page.slice(0, 1_000),
    );
  }
  options.onPage?.(page);
  return parseRucPage(page, ruc);
}

/**
 * Es una lectura sin efecto: además de los fallos pasajeros de red/HTTP (como las demás lecturas),
 * se reintenta cuando la página de resultado no se puede interpretar.
 */
function shouldRetryConsultRuc(error: unknown): boolean {
  return isRetryableRead(error) || (error instanceof RucPageError && error.retryable);
}

/** ¿El error es el desafío anti-bot de Cloudflare (viene con `CHALLENGE_CODE`)? */
function isChallenge(error: unknown): boolean {
  return error instanceof SunatApiError && error.code === CHALLENGE_CODE;
}

function fallbackTransport(options: RucConsultOptions): typeof fetch | undefined {
  if (options.curlFallback === false || options.fetch !== undefined) return undefined;
  return isCurlAvailable() ? curlFetch({ timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS }) : undefined;
}

async function consultOnce(ruc: string, options: RucConsultOptions): Promise<RucConsultResult> {
  try {
    return await fetchRucPage(ruc, options);
  } catch (error) {
    const curl = isChallenge(error) ? fallbackTransport(options) : undefined;
    if (!curl) throw error;
    try {
      return await fetchRucPage(ruc, { ...options, fetch: curl });
    } catch (fallbackError) {
      if (fallbackError instanceof SunatApiError && fallbackError.code === CHALLENGE_CODE) {
        throw challengeStuck(fallbackError);
      }
      throw error; // fallo del transporte curl (p. ej.executable): el padre es el desafío de SUNAT
    }
  }
}

/** El desafío persiste también con curl: devuélvelo con las alternativas que quedan. */
function challengeStuck(error: SunatApiError): SunatApiError {
  return new SunatApiError(
    `SUNAT respondió HTTP ${error.status} con un desafío anti-bot de Cloudflare ("Just a moment") que ni el fetch de ` +
      'Node ni el curl del sistema superan. Opciones: esperar a que SUNAT retire el desafío (su configuración va ' +
      'rotando, verificado 03–04/11/2026), consultar desde un entorno cuya huella pase (p. ej. `urllib` de Python o ' +
      'curl en otra plataforma), o revisar `scripts/ruc-consult.ts` y README "Anti-bot". (Las cookies del navegador ' +
      'no bastan: el desafío va atado a la huella del cliente.)',
    error.status,
    CHALLENGE_CODE,
    [],
    error.rawBody,
  );
}

/**
 * Consulta a SUNAT los datos públicos de un contribuyente por su RUC, con el servicio "Consulta RUC" del
 * formulario de `e-consultaruc.sunat.gob.pe`. No necesita certificado ni credenciales. Se importa desde la entrada
 * `@alonso804/sunat-sdk/ruc`, separada de `SunatClient`.
 *
 * Hace el mismo POST que el formulario web (`accion=consPorRuc`) con un token de reCAPTCHA simulado (nota de arriba)
 * e interpreta la página HTML de resultado. Los reintentos cubren fallos de red y páginas inesperadas; "no
 * encontrado" es un resultado, no un error.
 *
 * @param ruc - RUC de 11 dígitos, con prefijo y dígito verificador válidos (se comprueba antes de consultar).
 * @param options - `fetch` propio (pruebas/proxies), tiempo máximo por intento, reintentos y su pausa, cabeceras
 *   extra, el fallback automático con curl y un gancho para diagnóstico de la página cruda.
 * @returns `status: 'found'` con los datos tal como SUNAT los publica, o `status: 'not_found'` si SUNAT procesó la
 *   consulta y no informa datos: pasa con RUC que no existen y también cuando SUNAT está saturada (una consulta
 *   repetida puede traer datos), así que quien llama decide si reintenta después.
 * @throws {SunatValidationError} Si el RUC no es válido (no se contacta a SUNAT).
 * @throws {RucPageError} Si la página no se puede interpretar o SUNAT responde por otro RUC, tras los reintentos.
 * @throws {SunatApiError} Si SUNAT responde con un error, o con un
 *   desafío anti-bot que el fallback de curl no pudo superar (`CHALLENGE_CODE`, no se reintenta).
 * @throws {SunatTransportError} Si falla la red tras los reintentos.
 *
 * @example
 * ```ts
 * const result = await consultRuc('20539579356');
 * if (result.status === RucConsultStatus.notFound) throw new Error('SUNAT no informa datos; reintenta más tarde');
 * console.log(result.legalName); // "EMPRESA DE TRANSPORTES PERU BUS KLEY S.A.C."
 * console.log(result.mainActivity?.code); // "4921" (CIIU Rev. 4)
 * ```
 */
export async function consultRuc(rucInput: string, options: RucConsultOptions = {}): Promise<RucConsultResult> {
  const ruc = rucInput.trim();
  if (!isValidRuc(ruc)) {
    throw new SunatValidationError('El RUC a consultar no es válido.', [
      { path: 'ruc', message: 'Debe tener 11 dígitos, prefijo de tipo de contribuyente y dígito verificador válido' },
    ]);
  }
  return withRetries(() => consultOnce(ruc, options), shouldRetryConsultRuc, options.retry);
}
