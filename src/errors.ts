export class SunatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Los datos de entrada no son válidos; se detecta antes de contactar a SUNAT. */
export class SunatValidationError extends SunatError {
  constructor(
    message: string,
    readonly issues: ReadonlyArray<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}

/**
 * SUNAT respondió con un SOAP Fault. Según el manual del programador hay dos casos
 * con consecuencias distintas (ver `kind`).
 */
export class SunatFaultError extends SunatError {
  constructor(
    /** Código SUNAT, por ejemplo "1036" (excepción) o "3291" (rechazo por cálculo de IGV). */
    readonly code: string,
    /** Texto del fault tal como lo devuelve SUNAT. */
    readonly sunatMessage: string,
    readonly httpStatus?: number,
  ) {
    super(`SUNAT ${code}: ${sunatMessage}`);
  }

  /**
   * - `exception` (0100–1999): error grave que impide procesar el archivo. El comprobante
   *   se considera NO informado: se corrige y se puede reenviar con el MISMO número.
   * - `rejected` (2000–3999): SUNAT lo procesó pero no es válido. En facturas y notas el
   *   número queda CONSUMIDO: hay que emitir un comprobante nuevo con OTRO número.
   */
  get kind(): 'exception' | 'rejected' | 'unknown' {
    const n = Number(this.code);
    if (!Number.isFinite(n)) return 'unknown';
    if (n >= 100 && n <= 1999) return 'exception';
    if (n >= 2000 && n <= 3999) return 'rejected';
    return 'unknown';
  }
}

/**
 * La API REST de SUNAT (guías de remisión, autenticación) respondió con un error HTTP.
 * Formatos documentados: `{ cod, msg, exc }` (error general) y, con HTTP 422,
 * `{ cod, msg, errors: [{ codError, desError }] }` (error de validación del servicio).
 */
export class SunatApiError extends SunatError {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details: ReadonlyArray<{ code?: string; message: string }> = [],
    /** Cuerpo de la respuesta tal cual (recortado), útil para diagnosticar. */
    readonly rawBody?: string,
  ) {
    super(message);
  }

  /** 401/403: credenciales (client_id/secret o usuario/clave SOL) o permisos incorrectos. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** Conviene reintentar tras una pausa (timeouts, límite de peticiones o fallo del servidor). */
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/**
 * Fallo de red o respuesta que no es un SOAP válido: no se sabe si SUNAT recibió el comprobante.
 * Antes de reenviar con otro número, consulta el estado del comprobante.
 */
export class SunatTransportError extends SunatError {
  constructor(
    message: string,
    options?: { cause?: unknown; httpStatus?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.httpStatus = options?.httpStatus;
  }

  readonly httpStatus: number | undefined;

  /**
   * Conviene reintentar tras una pausa: caídas de red, 401/408/429 y 5xx sin SOAP.
   * (El proxy de SUNAT responde 401 cuando recibe varias peticiones muy seguidas.)
   */
  get retryable(): boolean {
    const s = this.httpStatus;
    return s === undefined || s === 401 || s === 408 || s === 429 || s >= 500;
  }
}
