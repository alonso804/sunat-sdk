import { SunatError } from '../errors';

/**
 * Estados de `RucConsultResult`. Es un objeto `as const` y a la vez un tipo con el mismo nombre (como las clases de
 * error): `RucConsultStatus.found` es el valor y `RucConsultStatus` la unión de todos.
 */
export const RucConsultStatus = {
  /** SUNAT informó los datos públicos del contribuyente. */
  found: 'found',
  /** SUNAT procesó la consulta sin informar datos: RUC inexistente o SUNAT saturada (reintenta más tarde). */
  notFound: 'not_found',
} as const;
export type RucConsultStatus = (typeof RucConsultStatus)[keyof typeof RucConsultStatus];

/**
 * Resultado de la Consulta RUC. Como los demás resultados del SDK, se distingue por `status`:
 * - `found`: SUNAT informó los datos públicos del contribuyente.
 * - `not_found`: SUNAT procesó la consulta sin informar datos. Pasa con RUC que no existen y también con una SUNAT
 *   saturada (una consulta repetida puede traer datos): reintenta más tarde antes de darlo por inexistente.
 */
export type RucConsultResult =
  | {
      status: typeof RucConsultStatus.found;
      /** El RUC consultado (se comprueba que SUNAT responda por él, no por otro). */
      ruc: string;
      /** Razón social: la parte del texto "20539579356 - EMPRESA DE TRANSPORTES PERU BUS KLEY S.A.C." tras el "-". */
      legalName: string;
      /** Nombre comercial, si está registrado (puede faltar aunque el RUC exista). */
      tradeName?: string;
      /** Estado del contribuyente: "ACTIVO", "BAJA DE OFICIO", "CDP BAJA"… */
      taxpayerStatus?: string;
      /** Condición del contribuyente: "HABIDO", "NO HABIDO"… */
      taxpayerCondition?: string;
      /** Domicilio fiscal, tal como lo muestra SUNAT. */
      fiscalAddress?: string;
      /** Actividad económica principal, con su código CIIU (Rev. 4, p. ej. "4921") si SUNAT lo separa en la página. */
      mainActivity?: RucMainActivity;
    }
  | {
      status: typeof RucConsultStatus.notFound;
      /** El RUC consultado. */
      ruc: string;
    };

/** Actividad económica principal de la Consulta RUC. */
export type RucMainActivity = {
  code: string | undefined;
  description: string;
};

/**
 * SUNAT entregó una página que no es un resultado de la Consulta RUC que se pueda interpretar, o respondió por otro
 * RUC. Es un error del SDK al leer la página, no un código de SUNAT: por eso es una clase aparte y no un
 * `SunatApiError` (cuyo `code` es siempre el que devuelve SUNAT).
 */
export class RucPageError extends SunatError {
  constructor(
    message: string,
    /** Recorte de la página recibida (hasta 1000 caracteres), útil para diagnosticar. */
    readonly rawBody: string,
  ) {
    super(message);
  }

  /** Siempre conviene reintentar tras una pausa: una SUNAT saturada a veces responde con otra página. */
  get retryable(): boolean {
    return true;
  }
}

/** Trozo del título de la página de resultado: si aparece sin bloque de RUC, SUNAT procesó la consulta y no encontró datos. */
const PAGE_RESULT_TITLE = 'Resultado de la B';

/** Reglas copiadas de la lógica de referencia (consulta_sunat.py), probadas contra la página real de SUNAT. */
const RE_RUC = /N(?:&uacute;|ú)mero de RUC:\s*<\/h4>.*?<h4[^>]*>\s*(\d{11})\s*-\s*(.*?)\s*<\/h4>/is;
const RE_ACTIVITIES = /Actividad\(es\) Econ(?:&oacute;|ó)mica\(s\):\s*<\/h4>([\s\S]*?)<\/table>/i;
const RE_PRINCIPAL = /<td>\s*Principal\s*-\s*([\s\S]*?)\s*<\/td>/i;
const RE_CIIU = /^(\d+)\s*-\s*([\s\S]*)$/;

/** Entidades que trae la página de SUNAT (acentos es-PE y signos comunes); las desconocidas quedan igual. */
const ENTITIES: Record<string, string> = {
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  Uuml: 'Ü',
  agrave: 'à',
  egrave: 'è',
  ograve: 'ò',
  ugrave: 'ù',
  Agrave: 'À',
  Egrave: 'È',
  Ograve: 'Ò',
  Ugrave: 'Ù',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  deg: '°',
  iexcl: '¡',
  sect: '§',
  middot: '·',
  times: '×',
  sup2: '²',
  sup3: '³',
  frac12: '½',
};

function unescapeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);/g, (whole, name: string) => {
    if (name[0] === '#') {
      const hexadecimal = name[1] === 'x';
      const code = Number.parseInt(hexadecimal ? name.slice(2) : name.slice(1), hexadecimal ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

/** El `limpiar()` del script de referencia: quita etiquetas, resuelve entidades y compacta espacios. */
function clean(text: string): string {
  return unescapeEntities(text.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** En el patrón de una etiqueta, acepta cada acento tal como llegue de SUNAT: como carácter o como entidad HTML. */
function flexible(text: string): string {
  return escapeRegExp(text)
    .replace(/á/gi, '(?:&aacute;|&Aacute;|á|Á)')
    .replace(/é/gi, '(?:&eacute;|&Eacute;|é|É)')
    .replace(/í/gi, '(?:&iacute;|&Iacute;|í|Í)')
    .replace(/ó/gi, '(?:&oacute;|&Oacute;|ó|Ó)')
    .replace(/ú/gi, '(?:&uacute;|&Uacute;|ú|Ú)')
    .replace(/ñ/gi, '(?:&ntilde;|&Ntilde;|ñ|Ñ)')
    .replace(/ü/gi, '(?:&uuml;|&Uuml;|ü|Ü)');
}

/**
 * La ficha del contribuyente en la página real (estructura Bootstrap, revisada el 04/11/2026): cada dato va en un
 * `h4` con la etiqueta (p. ej. "Estado del Contribuyente:") seguido del valor en un `<p class="list-group-item-text">`.
 */
function fieldValue(page: string, label: string): string | undefined {
  const re = new RegExp(`<h4[^>]*>\\s*${flexible(label)}\\s*:?\\s*<\\/h4>[\\s\\S]*?<p[^>]*>([\\s\\S]*?)<\\/p>`, 'i');
  const value = clean(re.exec(page)?.[1] ?? '');
  return value && value !== '-' ? value : undefined; // "-" o vacío (o "&nbsp;"): SUNAT no informa el dato
}

/**
 * Interpreta la página de resultado de la Consulta RUC, tomando los mismos datos del script de referencia
 * (razón social, actividad económica principal) y los campos de la ficha (nombre comercial, estado, condición,
 * domicilio fiscal).
 *
 * @returns `status: 'found'` con los datos publicados, o `status: 'not_found'` si SUNAT procesó la consulta sin
 *   informar datos (pasa con RUC inexistentes y también con una SUNAT saturada).
 * @throws {RucPageError} Si la página no se parece a un resultado de SUNAT, o si responde por otro RUC (`retryable`:
 *   `consultRuc` los reintenta). Guarda un recorte de la página en `rawBody`.
 */
export function parseRucPage(page: string, requestedRuc: string): RucConsultResult {
  const unexpected = (message: string): RucPageError => new RucPageError(message, page.slice(0, 1000));
  const mRuc = RE_RUC.exec(page);
  if (!mRuc) {
    // El título es de la página de resultado: la consulta se procesó y SUNAT no trae datos para ese RUC.
    if (page.includes(PAGE_RESULT_TITLE)) return { status: RucConsultStatus.notFound, ruc: requestedRuc };
    throw unexpected('La respuesta de SUNAT no es una página de resultado de la Consulta RUC.');
  }
  const respondedRuc = mRuc[1]!;
  if (respondedRuc !== requestedRuc) {
    throw unexpected(`SUNAT respondió por otro RUC (${respondedRuc}); se pidió ${requestedRuc}.`);
  }

  const result: Extract<RucConsultResult, { status: typeof RucConsultStatus.found }> = {
    status: RucConsultStatus.found,
    ruc: requestedRuc,
    legalName: clean(mRuc[2]!),
  };

  const activities = RE_ACTIVITIES.exec(page)?.[1];
  const principal = activities ? RE_PRINCIPAL.exec(activities)?.[1] : undefined;
  if (principal) {
    const text = clean(principal); // p. ej. "4921 - TRANSPORTE MUNICIPAL DE PASAJEROS"
    const withCode = RE_CIIU.exec(text);
    const mainActivity: RucMainActivity = withCode
      ? { code: withCode[1]!, description: clean(withCode[2]!) }
      : { code: undefined, description: text };
    result.mainActivity = mainActivity;
  }

  const tradeName = fieldValue(page, 'Nombre Comercial');
  const status = fieldValue(page, 'Estado del Contribuyente');
  const condition = fieldValue(page, 'Condición del Contribuyente');
  const fiscalAddress = fieldValue(page, 'Domicilio Fiscal');
  if (tradeName) result.tradeName = tradeName;
  if (status) result.taxpayerStatus = status;
  if (condition) result.taxpayerCondition = condition;
  if (fiscalAddress) result.fiscalAddress = fiscalAddress;

  return result;
}
