import { createHash } from 'node:crypto';
import { SunatApiError, SunatTransportError } from '../errors';

/**
 * Plataforma nueva de GRE (REST). Rutas según el manual "Servicios web - plataforma nueva GRE"
 * de SUNAT; el propio manual advierte que las URI son referenciales.
 */
export const GRE_ENDPOINTS = {
  auth: 'https://api-seguridad.sunat.gob.pe/v1',
  api: 'https://api-cpe.sunat.gob.pe/v1',
} as const;

/** Alcance (scope) que se pide al generar el token. */
export const GRE_SCOPE = 'https://api-cpe.sunat.gob.pe';

export type RestOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type TokenRequest = RestOptions & {
  authEndpoint?: string;
  /** Id generado en SOL → Credenciales de API SUNAT. */
  clientId: string;
  /** Clave generada en SOL → Credenciales de API SUNAT. */
  clientSecret: string;
  /** `<RUC><usuario SOL>`. */
  username: string;
  /** Clave SOL del usuario. */
  password: string;
};

export type Token = {
  accessToken: string;
  /** Instante de expiración (ms desde epoch). SUNAT lo entrega en segundos; hoy dura 1 hora. */
  expiresAt: number;
};

async function readBody(response: Response): Promise<{ text: string; json: Record<string, any> | undefined }> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return { text, json: parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : undefined };
  } catch {
    return { text, json: undefined };
  }
}

function toApiError(status: number, body: { text: string; json: Record<string, any> | undefined }): SunatApiError {
  const json = body.json;
  const errors = Array.isArray(json?.errors) ? (json.errors as Array<Record<string, unknown>>) : [];
  const details = errors.map((e) => {
    const code = e.codError ?? e.cod;
    const message = String(e.desError ?? e.msg ?? '');
    return code === undefined ? { message } : { code: String(code), message };
  });
  const code = json?.cod !== undefined ? String(json.cod) : json?.error !== undefined ? String(json.error) : undefined;
  const message =
    (json?.msg as string | undefined) ??
    (json?.error_description as string | undefined) ??
    (details[0]?.message || undefined) ??
    `SUNAT respondió HTTP ${status}`;
  return new SunatApiError(`${message} (HTTP ${status})`, status, code, details, body.text.slice(0, 1000));
}

async function request(url: string, init: RequestInit, options: RestOptions): Promise<{ status: number; json: Record<string, any> }> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? 60_000) });
  } catch (cause) {
    throw new SunatTransportError('No se pudo contactar a SUNAT; no se sabe si la solicitud fue recibida.', { cause });
  }
  const body = await readBody(response);
  if (!response.ok) throw toApiError(response.status, body);
  if (!body.json) {
    throw new SunatApiError(`Respuesta inesperada de SUNAT (HTTP ${response.status}).`, response.status, undefined, [], body.text.slice(0, 1000));
  }
  return { status: response.status, json: body.json };
}

/** Genera un token de acceso (OAuth2, grant `password`). Dura aproximadamente 1 hora. */
export async function requestToken(request_: TokenRequest, now: () => number = Date.now): Promise<Token> {
  const base = request_.authEndpoint ?? GRE_ENDPOINTS.auth;
  const form = new URLSearchParams({
    grant_type: 'password',
    scope: GRE_SCOPE,
    client_id: request_.clientId,
    client_secret: request_.clientSecret,
    username: request_.username,
    password: request_.password,
  });
  const { json } = await request(
    `${base}/clientessol/${encodeURIComponent(request_.clientId)}/oauth2/token/`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
    request_,
  );
  const accessToken = json.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new SunatApiError('SUNAT no devolvió un token de acceso.', 200, undefined, [], JSON.stringify(json).slice(0, 500));
  }
  const expiresInSeconds = Number(json.expires_in);
  return { accessToken, expiresAt: now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1000 };
}

export type SendOptions = RestOptions & {
  apiEndpoint?: string;
  token: string;
  /** Nombre base sin extensión: `<RUC>-09-<SERIE>-<CORRELATIVO>`. */
  baseName: string;
  /** ZIP con el XML firmado dentro. */
  zip: Uint8Array;
};

export type SendReceipt = {
  /** Identificador (UUID) con el que se consulta el resultado. */
  ticket: string;
  /** Fecha de recepción informada por SUNAT. */
  receivedAt: string | undefined;
};

/** Envía el comprobante. SUNAT lo procesa de forma asíncrona y devuelve un ticket. */
export async function postDespatch(options: SendOptions): Promise<SendReceipt> {
  const base = options.apiEndpoint ?? GRE_ENDPOINTS.api;
  const body = {
    archivo: {
      nomArchivo: `${options.baseName}.zip`,
      arcGreZip: Buffer.from(options.zip).toString('base64'),
      hashZip: createHash('sha256').update(options.zip).digest('hex'),
    },
  };
  const { json } = await request(
    `${base}/contribuyente/gem/comprobantes/${encodeURIComponent(options.baseName)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify(body),
    },
    options,
  );
  const ticket = json.numTicket;
  if (typeof ticket !== 'string' || !ticket) {
    throw new SunatApiError('SUNAT no devolvió el número de ticket.', 200, undefined, [], JSON.stringify(json).slice(0, 500));
  }
  return { ticket, receivedAt: typeof json.fecRecepcion === 'string' ? json.fecRecepcion : undefined };
}

export type TicketStatus = {
  /** "0" = procesado correctamente, "98" = en proceso (consultar de nuevo), "99" = procesado con errores. */
  code: string;
  error: { number: string; description: string } | undefined;
  /** CDR (ZIP en base64), cuando SUNAT lo genera. */
  cdrBase64: string | undefined;
  cdrGenerated: boolean;
};

export type StatusOptions = RestOptions & {
  apiEndpoint?: string;
  token: string;
  ticket: string;
};

/** Consulta el resultado de un envío por su ticket. */
export async function getTicketStatus(options: StatusOptions): Promise<TicketStatus> {
  const base = options.apiEndpoint ?? GRE_ENDPOINTS.api;
  const { json } = await request(
    `${base}/contribuyente/gem/comprobantes/envios/${encodeURIComponent(options.ticket)}`,
    { method: 'GET', headers: { Authorization: `Bearer ${options.token}` } },
    options,
  );
  const error = json.error && typeof json.error === 'object' ? (json.error as Record<string, unknown>) : undefined;
  return {
    code: String(json.codRespuesta ?? ''),
    error: error ? { number: String(error.numError ?? ''), description: String(error.desError ?? '') } : undefined,
    cdrBase64: typeof json.arcCdr === 'string' && json.arcCdr ? json.arcCdr : undefined,
    cdrGenerated: String(json.indCdrGenerado ?? '') === '1',
  };
}
