import { readCdrFromApplicationResponse, type Cdr } from './cdr';
import { ENDPOINTS, type Environment } from './config';
import type { DespatchInput } from './despatch/schema';
import {
  prepareDespatch,
  waitForDespatch,
  type DespatchResult,
  type DespatchSendOptions,
  type PreparedDespatch,
} from './despatch/service';
import { SunatApiError, SunatError, SunatFaultError, SunatValidationError } from './errors';
import { getTicketStatus, postDespatch, requestToken, type Token } from './gre/api';
import { downloadDespatchPdf, type DespatchPdf, type DespatchPdfOptions } from './gre/pdf';
import { calculateInvoice } from './invoice/calculate';
import { resolvePayment } from './invoice/payment';
import { InvoiceSchema, IssuerSchema, type InvoiceInput, type Issuer, type IssuerInput } from './invoice/schema';
import { buildInvoiceXml, invoiceBaseName } from './invoice/xml';
import { fmt2, fmtUpTo } from './money';
import { amountInWords } from './numero-a-letras';
import type { SigningKey } from './signing/certificate';
import { extractDigestValue, signUblXml, type SignatureAlgorithm } from './signing/xmldsig';
import { isRetryableRead, isSafeToResend, withRetries, type RetryOptions } from './retry';
import { getStatusCdr, sendBill } from './soap/bill-service';
import { toValidationError } from './validation';
import { limaDateTime } from './xml';
import { zipSingleFile } from './zip';

/** Credenciales de la API REST de SUNAT (guías de remisión), generadas en SOL → Credenciales de API SUNAT. */
export interface GreCredentials {
  clientId: string;
  clientSecret: string;
  /** Solo para pruebas o proxies. */
  apiEndpoint?: string;
  authEndpoint?: string;
}

export interface SunatClientConfig {
  environment: Environment;
  /** Datos del contribuyente que emite. */
  issuer: IssuerInput;
  /**
   * Credenciales SOL con las que se autentica el servicio. Se recomienda un usuario secundario
   * con permisos solo para emitir comprobantes. En beta: usuario "MODDATOS", clave "MODDATOS".
   */
  sol: { user: string; password: string };
  /** Credenciales de API para las guías de remisión. Solo hacen falta si vas a emitir guías. */
  gre?: GreCredentials;
  /** Llave privada y certificado digital con los que se firma cada comprobante. */
  signingKey: SigningKey;
  /** Algoritmo de firma. El manual de SUNAT documenta "sha1" (por defecto). */
  signatureAlgorithm?: SignatureAlgorithm;
  /** Para pruebas o proxies. Por defecto el `fetch` global. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Reintentos automáticos (por defecto 3, con pausas de 1 s, 2 s y 4 s; `{ maxRetries: 0 }` los desactiva).
   * - Envíos (`sendInvoice`, `sendDespatch`): solo si SUNAT con seguridad no procesó la petición (401/429/503 del
   *   proxy, o la conexión no llegó a abrirse). Un corte con la petición ya enviada no se reintenta.
   * - Lecturas (token de la API, `getInvoiceStatus`, `getDespatchStatus`): ante cualquier fallo pasajero.
   */
  retry?: RetryOptions;
  /** Reloj inyectable (pruebas). */
  now?: () => Date;
}

/** Resumen legible para mostrar al usuario y pedir confirmación antes de emitir. */
export interface InvoiceSummary {
  series: string;
  number: number;
  currency: 'PEN' | 'USD';
  customer: { ruc: string; name: string };
  lines: Array<{ description: string; quantity: string; unitPrice: string; lineValue: string; igv: string }>;
  taxedBase: string;
  exoneratedBase: string;
  unaffectedBase: string;
  igv: string;
  total: string;
  totalInWords: string;
  /** Forma de pago ya resuelta: en crédito, el monto neto pendiente (por defecto el total) y las cuotas con su monto. */
  payment:
    | { type: 'cash' }
    | { type: 'credit'; netPending: string; installments: Array<{ number: number; dueDate: string; amount: string }> };
  purchaseOrder?: string;
  relatedDespatches: Array<{ type: '09' | '31'; number: string }>;
}

/** Factura validada, calculada y firmada, lista para enviarse. No tiene efecto hasta que se envía. */
export interface PreparedInvoice {
  /** `<RUC>-01-<SERIE>-<CORRELATIVO>`: nombre de los archivos XML y ZIP. */
  baseName: string;
  signedXml: string;
  /** Hash (DigestValue) del documento, necesario para el código QR de la representación impresa. */
  digestValue: string | undefined;
  issuedAt: Date;
  summary: InvoiceSummary;
}

/** Comprobante que se consulta con `getInvoiceStatus` (siempre del emisor configurado en el cliente). */
export interface InvoiceStatusQuery {
  /** Serie de 4 caracteres, por ejemplo "F001". */
  series: string;
  /** Correlativo, entero positivo. */
  number: number;
  /** 01 = factura (por defecto), 07 = nota de crédito, 08 = nota de débito. */
  type?: '01' | '07' | '08';
}

export interface InvoiceStatusResult {
  /** Código que devuelve SUNAT (p. ej. "0001"). El manual no publica la tabla completa para `getStatusCdr`: se devuelve tal cual. */
  statusCode: string;
  /** Mensaje de SUNAT que acompaña al código. */
  statusMessage: string;
  /** CDR del comprobante, solo si SUNAT lo adjuntó. */
  cdr?: Cdr;
  /** CDR tal como lo devolvió SUNAT (ZIP), solo si lo adjuntó. */
  cdrZip?: Uint8Array;
}

export type SendInvoiceResult =
  | {
      status: 'accepted' | 'accepted_with_observations';
      baseName: string;
      cdr: Cdr;
      /** CDR tal como lo devolvió SUNAT (ZIP); conviene guardarlo como constancia. */
      cdrZip: Uint8Array;
    }
  | {
      /**
       * SUNAT rechazó el comprobante por incumplir una regla de validación (códigos 2000–3999).
       * IMPORTANTE: en facturas y notas el correlativo queda CONSUMIDO; corrige el problema y
       * emite un comprobante nuevo con el siguiente número.
       */
      status: 'rejected';
      baseName: string;
      code: string;
      message: string;
    };

export class SunatClient {
  readonly issuer: Issuer;
  private greToken: Token | undefined;

  constructor(private readonly config: SunatClientConfig) {
    const parsed = IssuerSchema.safeParse(config.issuer);
    if (!parsed.success) throw toValidationError(parsed.error);
    this.issuer = parsed.data;
  }

  /**
   * Valida, calcula totales, genera el XML UBL 2.1 y lo firma. No contacta a SUNAT.
   * Úsalo para mostrar un resumen y pedir confirmación antes de `sendInvoice`.
   */
  prepareInvoice(input: InvoiceInput): PreparedInvoice {
    const parsed = InvoiceSchema.safeParse(input);
    if (!parsed.success) throw toValidationError(parsed.error);
    const invoice = parsed.data;

    const issuedAt = invoice.issuedAt ?? this.config.now?.() ?? new Date();
    const calculation = calculateInvoice(invoice);
    const payment = resolvePayment(invoice.payment, calculation.totals.payable, limaDateTime(issuedAt).date);
    const unsignedXml = buildInvoiceXml({ issuer: this.issuer, invoice, calculation, payment, issuedAt });
    const signedXml = signUblXml(unsignedXml, this.config.signingKey, this.config.signatureAlgorithm ?? 'sha1');
    const { totals } = calculation;

    return {
      baseName: invoiceBaseName(this.issuer.ruc, invoice),
      signedXml,
      digestValue: extractDigestValue(signedXml),
      issuedAt,
      summary: {
        series: invoice.series,
        number: invoice.number,
        currency: invoice.currency,
        customer: { ruc: invoice.customer.ruc, name: invoice.customer.name },
        lines: calculation.lines.map((line) => ({
          description: line.description,
          quantity: fmtUpTo(line.quantity, 10),
          unitPrice: fmtUpTo(line.unitPrice, 10),
          lineValue: fmt2(line.lineValue),
          igv: fmt2(line.igv),
        })),
        taxedBase: fmt2(totals.taxedBase),
        exoneratedBase: fmt2(totals.exoneratedBase),
        unaffectedBase: fmt2(totals.unaffectedBase),
        igv: fmt2(totals.igv),
        total: fmt2(totals.payable),
        totalInWords: amountInWords(totals.payable, invoice.currency),
        payment:
          payment.type === 'cash'
            ? { type: 'cash' }
            : {
                type: 'credit',
                netPending: fmt2(payment.netPending),
                installments: payment.installments.map((i) => ({ number: i.number, dueDate: i.dueDate, amount: fmt2(i.amount) })),
              },
        ...(invoice.purchaseOrder ? { purchaseOrder: invoice.purchaseOrder } : {}),
        relatedDespatches: invoice.relatedDespatches.map((d) => ({ type: d.type, number: `${d.series}-${d.number}` })),
      },
    };
  }

  /**
   * Envía la factura a SUNAT y devuelve el resultado.
   *
   * - Aceptada (con o sin observaciones) o rechazada por validación: se devuelve el resultado.
   *   Un rechazo consume el correlativo (ver `SendInvoiceResult`).
   * - Excepción de SUNAT (`SunatFaultError` con `kind === 'exception'`): el comprobante quedó
   *   "no informado"; corrige y reenvía con el MISMO correlativo.
   * - Error de red (`SunatTransportError`): no se sabe si SUNAT lo recibió. NO generes otro
   *   correlativo: reenvía el mismo comprobante o consulta su estado.
   * - No envíes varias facturas en paralelo: el proxy de SUNAT puede responder 401.
   */
  async sendInvoice(prepared: PreparedInvoice): Promise<SendInvoiceResult> {
    const { baseName } = prepared;
    const zip = zipSingleFile(`${baseName}.xml`, prepared.signedXml);

    let applicationResponse: string;
    try {
      applicationResponse = await withRetries(
        () =>
          sendBill({
            endpoint: ENDPOINTS[this.config.environment].billService,
            auth: { username: `${this.issuer.ruc}${this.config.sol.user}`, password: this.config.sol.password },
            fileName: `${baseName}.zip`,
            zipBase64: Buffer.from(zip).toString('base64'),
            ...this.restOptions(),
          }),
        isSafeToResend,
        this.config.retry,
      );
    } catch (error) {
      if (error instanceof SunatFaultError && error.kind === 'rejected') {
        return { status: 'rejected', baseName, code: error.code, message: error.sunatMessage };
      }
      throw error;
    }

    const { cdr, cdrZip } = readCdrFromApplicationResponse(applicationResponse);
    if (!cdr.accepted) {
      return { status: 'rejected', baseName, code: cdr.responseCode, message: cdr.description };
    }
    return {
      status: cdr.notes.length > 0 ? 'accepted_with_observations' : 'accepted',
      baseName,
      cdr,
      cdrZip,
    };
  }

  /**
   * Consulta a SUNAT el estado y el CDR de una factura (o nota) ya informada (`getStatusCdr`).
   *
   * Es de solo lectura: sirve para saber qué pasó con un envío que terminó en error de red antes de reenviarlo,
   * para recuperar un CDR perdido y para comprobar en producción que el usuario y la clave SOL funcionan sin
   * crear nada. Solo existe en producción (SUNAT no publica el servicio de consulta en beta).
   *
   * Un comprobante que no existe o que no te pertenece lo informa SUNAT con un código o con una excepción
   * (`SunatFaultError`); el SDK no interpreta esos códigos porque el manual no los lista para este método.
   */
  async getInvoiceStatus(query: InvoiceStatusQuery): Promise<InvoiceStatusResult> {
    const type = query.type ?? '01';
    const series = query.series.trim().toUpperCase();
    const issues: Array<{ path: string; message: string }> = [];
    if (!['01', '07', '08'].includes(type)) issues.push({ path: 'type', message: 'Debe ser 01, 07 u 08' });
    if (!/^[A-Z0-9]{4}$/.test(series)) issues.push({ path: 'series', message: 'Debe tener 4 caracteres (letras o números)' });
    if (!Number.isInteger(query.number) || query.number < 1 || query.number > 99_999_999) {
      issues.push({ path: 'number', message: 'Debe ser un entero entre 1 y 99999999' });
    }
    if (issues.length > 0) throw new SunatValidationError('Los datos del comprobante a consultar no son válidos.', issues);

    const endpoint = ENDPOINTS[this.config.environment].consultService;
    if (!endpoint) {
      throw new SunatError(
        `El servicio de consulta de CDR no está disponible en el ambiente "${this.config.environment}": SUNAT solo lo publica para producción.`,
      );
    }
    const response = await withRetries(
      () =>
        getStatusCdr({
          endpoint,
          auth: { username: `${this.issuer.ruc}${this.config.sol.user}`, password: this.config.sol.password },
          query: { ruc: this.issuer.ruc, type, series, number: query.number },
          ...this.restOptions(),
        }),
      isRetryableRead,
      this.config.retry,
    );
    const result: InvoiceStatusResult = { statusCode: response.statusCode, statusMessage: response.statusMessage };
    if (response.contentBase64) {
      const { cdr, cdrZip } = readCdrFromApplicationResponse(response.contentBase64);
      result.cdr = cdr;
      result.cdrZip = cdrZip;
    }
    return result;
  }

  // ------------------------------------------------------------------------------------------
  // Guía de remisión electrónica del remitente (GRE, tipo 09) — API REST
  // ------------------------------------------------------------------------------------------

  /**
   * Valida, genera el XML UBL 2.1 de la GRE remitente y lo firma. No contacta a SUNAT.
   * Úsalo para mostrar `summary` y `warnings` y pedir confirmación antes de `sendDespatch`.
   */
  prepareDespatch(input: DespatchInput): PreparedDespatch {
    return prepareDespatch({
      issuer: this.issuer,
      input,
      signingKey: this.config.signingKey,
      algorithm: this.config.signatureAlgorithm ?? 'sha1',
      now: this.config.now ?? (() => new Date()),
    });
  }

  /**
   * Envía la GRE a SUNAT y espera el resultado (SUNAT la procesa de forma asíncrona).
   *
   * - `accepted` / `accepted_with_observations`: ya puedes iniciar el traslado; guarda el CDR.
   * - `rejected`: en guías el rechazo no invalida el número; corrige y reenvía.
   * - `pending`: SUNAT ya la recibió pero aún no se conoce el resultado (sigue procesando, o falló la consulta:
   *   ver `statusError`). Consulta con `getDespatchStatus({ baseName, ticket })`; no la reenvíes.
   * - Error lanzado (`SunatTransportError`, `SunatApiError`): ocurrió ANTES de obtener el ticket. Con un error de
   *   red no se sabe si SUNAT la recibió; no cambies el número.
   */
  async sendDespatch(prepared: PreparedDespatch, options: DespatchSendOptions = {}): Promise<DespatchResult> {
    const { baseName } = prepared;
    const zip = zipSingleFile(`${baseName}.xml`, prepared.signedXml);
    const gre = this.requireGre();

    const receipt = await this.withGreToken((token) =>
      withRetries(
        () =>
          postDespatch({
            token,
            baseName,
            zip,
            ...(gre.apiEndpoint ? { apiEndpoint: gre.apiEndpoint } : {}),
            ...this.restOptions(),
          }),
        isSafeToResend,
        this.config.retry,
      ),
    );
    // Desde aquí SUNAT ya tiene la guía: un fallo al consultar el resultado no debe perder el ticket.
    let result: DespatchResult;
    try {
      result = await waitForDespatch(() => this.fetchTicket(receipt.ticket), baseName, receipt.ticket, options);
    } catch (error) {
      const statusError = error instanceof Error ? error : new Error(String(error));
      return { status: 'pending', baseName, ticket: receipt.ticket, statusError };
    }
    return this.attachPdf(result, options.downloadPdf);
  }

  /**
   * Consulta el resultado de una GRE ya enviada, a partir de su ticket.
   * Con `downloadPdf: true`, si quedó aceptada, baja también el PDF oficial (ver `sendDespatch`).
   */
  async getDespatchStatus(ref: { baseName: string; ticket: string }, options: Pick<DespatchSendOptions, 'downloadPdf'> = {}): Promise<DespatchResult> {
    // Consulta única (sin sondeo), pero con reintentos: es una lectura sin efecto.
    const fetchStatus = () => withRetries(() => this.fetchTicket(ref.ticket), isRetryableRead, this.config.retry);
    const result = await waitForDespatch(fetchStatus, ref.baseName, ref.ticket, { maxWaitMs: 0 });
    return this.attachPdf(result, options.downloadPdf);
  }

  /** Baja el PDF oficial de una guía aceptada sin convertir un fallo de descarga en un error del envío. */
  private async attachPdf(result: DespatchResult, enabled: boolean | undefined): Promise<DespatchResult> {
    if (!enabled) return result;
    if (result.status !== 'accepted' && result.status !== 'accepted_with_observations') return result;
    const qrUrl = result.cdr.qrUrl;
    if (!qrUrl) return { ...result, pdfError: new SunatError('El CDR no trae la URL del QR; no hay PDF que descargar.') };
    try {
      return { ...result, pdf: await this.downloadDespatchPdf(qrUrl) };
    } catch (error) {
      return { ...result, pdfError: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /**
   * Descarga el PDF oficial de una GRE aceptada desde la URL del QR del CDR (`cdr.qrUrl`).
   * No requiere credenciales; solo acepta URLs https de sunat.gob.pe.
   */
  async downloadDespatchPdf(qrUrl: string, options: Pick<DespatchPdfOptions, 'retries' | 'retryDelayMs'> = {}): Promise<DespatchPdf> {
    return downloadDespatchPdf(qrUrl, { ...this.restOptions(), ...options });
  }

  private fetchTicket(ticket: string) {
    const gre = this.requireGre();
    return this.withGreToken((token) =>
      getTicketStatus({
        token,
        ticket,
        ...(gre.apiEndpoint ? { apiEndpoint: gre.apiEndpoint } : {}),
        ...this.restOptions(),
      }),
    );
  }

  private restOptions(): { fetch?: typeof fetch; timeoutMs?: number } {
    return {
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
      ...(this.config.timeoutMs ? { timeoutMs: this.config.timeoutMs } : {}),
    };
  }

  private requireGre(): GreCredentials {
    if (!this.config.gre) {
      throw new SunatValidationError(
        'Para emitir guías configura `gre: { clientId, clientSecret }` (SOL → Credenciales de API SUNAT).',
      );
    }
    return this.config.gre;
  }

  /** Usa el token en caché (se renueva 60 s antes de vencer) y reintenta una vez si SUNAT lo rechaza. */
  private async withGreToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    const now = this.config.now ?? (() => new Date());
    const fresh = (): boolean => this.greToken !== undefined && this.greToken.expiresAt - 60_000 > now().getTime();
    const wasCached = fresh();

    if (!fresh()) this.greToken = await this.newGreToken();
    try {
      return await call((this.greToken as Token).accessToken);
    } catch (error) {
      if (wasCached && error instanceof SunatApiError && error.isAuthError) {
        this.greToken = await this.newGreToken();
        return call(this.greToken.accessToken);
      }
      throw error;
    }
  }

  /** Pedir un token no crea nada en SUNAT: se reintenta ante fallos pasajeros (no ante credenciales incorrectas). */
  private newGreToken(): Promise<Token> {
    const gre = this.requireGre();
    return withRetries(
      () =>
        requestToken(
          {
            clientId: gre.clientId,
            clientSecret: gre.clientSecret,
            username: `${this.issuer.ruc}${this.config.sol.user}`,
            password: this.config.sol.password,
            ...(gre.authEndpoint ? { authEndpoint: gre.authEndpoint } : {}),
            ...this.restOptions(),
          },
          () => (this.config.now ?? (() => new Date()))().getTime(),
        ),
      isRetryableRead,
      this.config.retry,
    );
  }
}
