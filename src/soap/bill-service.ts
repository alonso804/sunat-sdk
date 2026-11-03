import { XMLParser } from 'fast-xml-parser';
import { SunatFaultError, SunatTransportError } from '../errors';
import { escapeXml } from '../xml';

const WSSE_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const PASSWORD_TEXT = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';

export type SoapAuth = {
  /** `<RUC><usuario SOL>`, por ejemplo "20123456789MODDATOS". */
  username: string;
  password: string;
};

const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });

/** Sobre SOAP con WS-Security (usuario y clave SOL en texto) y el cuerpo indicado. */
function soapEnvelope(auth: SoapAuth, bodyXml: string): string {
  return (
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.sunat.gob.pe">' +
    '<soapenv:Header>' +
    `<wsse:Security xmlns:wsse="${WSSE_NS}">` +
    '<wsse:UsernameToken>' +
    `<wsse:Username>${escapeXml(auth.username)}</wsse:Username>` +
    `<wsse:Password Type="${PASSWORD_TEXT}">${escapeXml(auth.password)}</wsse:Password>` +
    '</wsse:UsernameToken>' +
    '</wsse:Security>' +
    '</soapenv:Header>' +
    `<soapenv:Body>${bodyXml}</soapenv:Body>` +
    '</soapenv:Envelope>'
  );
}

export function buildSendBillEnvelope(auth: SoapAuth, fileName: string, zipBase64: string): string {
  return soapEnvelope(
    auth,
    '<ser:sendBill>' + `<fileName>${escapeXml(fileName)}</fileName>` + `<contentFile>${zipBase64}</contentFile>` + '</ser:sendBill>',
  );
}

/** SUNAT escapa los acentos como referencias numéricas (`&#243;`); las convertimos a texto. */
function decodeNumericEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

/** El código de SUNAT viaja en el faultcode ("soap-env:Client.0111") o al inicio del faultstring. */
function extractFaultCode(faultcode: string, faultstring: string): string {
  const fromCode = /(\d{3,4})\s*$/.exec(faultcode)?.[1];
  if (fromCode) return fromCode;
  // Solo al inicio ("3030 - ..."): un número en medio del texto (p. ej. "F001-1234") no es el código.
  const fromString = /^\s*(\d{4})\b/.exec(faultstring)?.[1];
  return fromString ?? (faultcode || 'UNKNOWN');
}

/** Lee el cuerpo SOAP; si SUNAT respondió con un Fault lanza `SunatFaultError`, y si es ilegible, `SunatTransportError`. */
function parseSoapBody(httpStatus: number, body: string): Record<string, any> | undefined {
  let parsed: Record<string, any>;
  try {
    parsed = parser.parse(body) as Record<string, any>;
  } catch (cause) {
    throw new SunatTransportError(`Respuesta ilegible de SUNAT (HTTP ${httpStatus}).`, { cause, httpStatus });
  }
  const soapBody = parsed.Envelope?.Body as Record<string, any> | undefined;
  const fault = soapBody?.Fault;
  if (fault) {
    const faultcode = String(fault.faultcode ?? '');
    const faultstring = decodeNumericEntities(String(fault.faultstring ?? ''));
    throw new SunatFaultError(extractFaultCode(faultcode, faultstring), faultstring, httpStatus);
  }
  return soapBody;
}

/**
 * Interpreta la respuesta HTTP de `sendBill`.
 * Devuelve el `applicationResponse` (CDR en ZIP/base64) o lanza SunatFaultError / SunatTransportError.
 */
export function parseSendBillResponse(httpStatus: number, body: string): string {
  const soapBody = parseSoapBody(httpStatus, body);
  const applicationResponse = soapBody?.sendBillResponse?.applicationResponse;
  if (httpStatus >= 200 && httpStatus < 300 && applicationResponse) return String(applicationResponse);

  throw new SunatTransportError(`Respuesta inesperada de SUNAT (HTTP ${httpStatus}).`, { httpStatus });
}

export type SendBillOptions = {
  endpoint: string;
  auth: SoapAuth;
  fileName: string;
  zipBase64: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export async function sendBill(options: SendBillOptions): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(options.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:sendBill' },
      body: buildSendBillEnvelope(options.auth, options.fileName, options.zipBase64),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (cause) {
    throw new SunatTransportError(
      'No se pudo contactar a SUNAT; no se sabe si el comprobante fue recibido. Consulta su estado antes de reenviar.',
      { cause },
    );
  }
  return parseSendBillResponse(response.status, await response.text());
}

// ---------------------------------------------------------------------------------------------
// getStatusCdr (servicio de consulta de SUNAT): estado y CDR de una factura o nota ya informada
// ---------------------------------------------------------------------------------------------

export type StatusCdrQuery = {
  /** RUC del emisor del comprobante. */
  ruc: string;
  /** 01 = factura, 07 = nota de crédito, 08 = nota de débito. */
  type: '01' | '07' | '08';
  series: string;
  number: number;
};

export function buildGetStatusCdrEnvelope(auth: SoapAuth, query: StatusCdrQuery): string {
  return soapEnvelope(
    auth,
    '<ser:getStatusCdr>' +
      `<rucComprobante>${escapeXml(query.ruc)}</rucComprobante>` +
      `<tipoComprobante>${query.type}</tipoComprobante>` +
      `<serieComprobante>${escapeXml(query.series)}</serieComprobante>` +
      `<numeroComprobante>${query.number}</numeroComprobante>` +
      '</ser:getStatusCdr>',
  );
}

export type StatusCdrResponse = {
  /** Código tal como lo devuelve SUNAT (el manual no publica la tabla completa para `getStatusCdr`). */
  statusCode: string;
  statusMessage: string;
  /** CDR (ZIP en base64) cuando SUNAT lo adjunta. */
  contentBase64: string | undefined;
};

/** Interpreta la respuesta de `getStatusCdr`. Un Fault de SUNAT se lanza como `SunatFaultError`. */
export function parseGetStatusCdrResponse(httpStatus: number, body: string): StatusCdrResponse {
  const soapBody = parseSoapBody(httpStatus, body);
  const status = soapBody?.getStatusCdrResponse?.statusCdr;
  if (httpStatus >= 200 && httpStatus < 300 && status && typeof status === 'object') {
    const content = typeof status.content === 'string' ? status.content.trim() : '';
    return {
      statusCode: String(status.statusCode ?? '').trim(),
      statusMessage: decodeNumericEntities(String(status.statusMessage ?? '')).trim(),
      contentBase64: content || undefined,
    };
  }
  throw new SunatTransportError(`Respuesta inesperada de SUNAT (HTTP ${httpStatus}).`, { httpStatus });
}

export type GetStatusCdrOptions = {
  endpoint: string;
  auth: SoapAuth;
  query: StatusCdrQuery;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export async function getStatusCdr(options: GetStatusCdrOptions): Promise<StatusCdrResponse> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(options.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:getStatusCdr' },
      body: buildGetStatusCdrEnvelope(options.auth, options.query),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (cause) {
    throw new SunatTransportError('No se pudo contactar al servicio de consulta de SUNAT.', { cause });
  }
  return parseGetStatusCdrResponse(response.status, await response.text());
}
