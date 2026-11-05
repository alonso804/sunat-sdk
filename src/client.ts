import { amountInWords } from './amount-in-words';
import type { Currency } from './catalogs';
import { type Cdr, readCdrFromApplicationResponse } from './cdr';
import { ENDPOINTS, type Environment } from './config';
import type { DespatchInput } from './despatch/schema';
import {
  type DespatchResult,
  type DespatchSendOptions,
  DespatchStatus,
  type PreparedDespatch,
  prepareDespatch,
  waitForDespatch,
} from './despatch/service';
import { SunatApiError, SunatError, SunatFaultError, SunatFaultKind, SunatValidationError } from './errors';
import { getTicketStatus, postDespatch, requestToken, type Token } from './gre/api';
import { type DespatchPdf, type DespatchPdfOptions, downloadDespatchPdf } from './gre/pdf';
import { calculateInvoice } from './invoice/calculate';
import { resolvePayment } from './invoice/payment';
import {
  type InvoiceInput,
  InvoiceSchema,
  type Issuer,
  type IssuerInput,
  IssuerSchema,
  PaymentType,
} from './invoice/schema';
import { buildInvoiceXml, invoiceBaseName } from './invoice/xml';
import { fmt2, fmtUpTo } from './money';
import { isRetryableRead, isSafeToResend, type RetryOptions, withRetries } from './retry';
import type { SigningKey } from './signing/certificate';
import { extractDigestValue, SignatureAlgorithm, signUblXml } from './signing/xmldsig';
import { getStatusCdr, sendBill } from './soap/bill-service';
import { TextCharset, toLatin1Deep } from './text-charset';
import { toValidationError } from './validation';
import { limaDateTime } from './xml';
import { zipSingleFile } from './zip';

/** Credenciales de la API REST de SUNAT (guías de remisión), generadas en SOL → Credenciales de API SUNAT. */
export type GreCredentials = {
  clientId: string;
  clientSecret: string;
  /** Solo para pruebas o proxies. */
  apiEndpoint?: string;
  authEndpoint?: string;
};

export type SunatClientConfig = {
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
  /**
   * Juego de caracteres del texto que se escribe en el XML (ver `TextCharset`). Por defecto `unicode`: se envía tal
   * cual, con tildes y cualquier símbolo. Con `latin1`, los caracteres fuera de Latin-1 se cambian por equivalentes
   * simples antes de firmar (aplica a los datos del emisor, de la factura y de la guía; se ve en `summary`).
   */
  textCharset?: TextCharset;
  /** Reloj inyectable (pruebas). */
  now?: () => Date;
};

/** Resumen legible para mostrar al usuario y pedir confirmación antes de emitir. */
export type InvoiceSummary = {
  series: string;
  number: number;
  currency: Currency;
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
    | { type: typeof PaymentType.cash }
    | {
        type: typeof PaymentType.credit;
        netPending: string;
        installments: Array<{ number: number; dueDate: string; amount: string }>;
      };
  purchaseOrder?: string;
  relatedDespatches: Array<{ type: '09' | '31'; number: string }>;
};

/** Factura validada, calculada y firmada, lista para enviarse. No tiene efecto hasta que se envía. */
export type PreparedInvoice = {
  /** `<RUC>-01-<SERIE>-<CORRELATIVO>`: nombre de los archivos XML y ZIP. */
  baseName: string;
  signedXml: string;
  /** Hash (DigestValue) del documento, necesario para el código QR de la representación impresa. */
  digestValue: string | undefined;
  issuedAt: Date;
  summary: InvoiceSummary;
};

/** Comprobante que se consulta con `getInvoiceStatus` (siempre del emisor configurado en el cliente). */
export type InvoiceStatusQuery = {
  /** Serie de 4 caracteres, por ejemplo "F001". */
  series: string;
  /** Correlativo, entero positivo. */
  number: number;
  /** 01 = factura (por defecto), 07 = nota de crédito, 08 = nota de débito. */
  type?: '01' | '07' | '08';
};

export type InvoiceStatusResult = {
  /** Código que devuelve SUNAT (p. ej. "0001"). El manual no publica la tabla completa para `getStatusCdr`: se devuelve tal cual. */
  statusCode: string;
  /** Mensaje de SUNAT que acompaña al código. */
  statusMessage: string;
  /** CDR del comprobante, solo si SUNAT lo adjuntó. */
  cdr?: Cdr;
  /** CDR tal como lo devolvió SUNAT (ZIP), solo si lo adjuntó. */
  cdrZip?: Uint8Array;
};

/**
 * Estados de `SendInvoiceResult`. Es un objeto `as const` y a la vez un tipo con el mismo nombre (como las clases de
 * error): `SendInvoiceStatus.rejected` es el valor y `SendInvoiceStatus` la unión de todos.
 */
export const SendInvoiceStatus = {
  /** Aceptada sin observaciones. */
  accepted: 'accepted',
  /** Aceptada con observaciones (códigos 4000+ en `cdr.notes`): conviene corregirlas en los próximos comprobantes. */
  acceptedWithObservations: 'accepted_with_observations',
  /** Rechazada por validación (códigos 2000–3999): en facturas y notas el correlativo queda CONSUMIDO. */
  rejected: 'rejected',
} as const;
export type SendInvoiceStatus = (typeof SendInvoiceStatus)[keyof typeof SendInvoiceStatus];

export type SendInvoiceResult =
  | {
      status: typeof SendInvoiceStatus.accepted | typeof SendInvoiceStatus.acceptedWithObservations;
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
      status: typeof SendInvoiceStatus.rejected;
      baseName: string;
      code: string;
      message: string;
    };

/** Guía ya enviada que se consulta con `getDespatchStatus`: sale de un resultado `pending` de `sendDespatch`. */
export type DespatchTicketRef = {
  /** `<RUC>-09-<SERIE>-<CORRELATIVO>`, el `baseName` del resultado. */
  baseName: string;
  /** Ticket que devolvió SUNAT al recibir la guía. */
  ticket: string;
};

/** Opciones de `getDespatchStatus`. */
export type DespatchStatusOptions = Pick<DespatchSendOptions, 'downloadPdf'>;

/** Opciones de `SunatClient.downloadDespatchPdf`: los reintentos de la descarga. */
export type DespatchPdfRetryOptions = Pick<DespatchPdfOptions, 'retry'>;

/**
 * Cliente para emitir comprobantes directo a SUNAT, sin PSE ni OSE: facturas (servicio SOAP) y guías de remisión
 * remitente (API REST).
 *
 * Cada emisión tiene dos pasos:
 * 1. `prepareInvoice` / `prepareDespatch`: valida, calcula y firma **sin contactar a SUNAT**. Muestra el `summary`
 *    al usuario y pide confirmación.
 * 2. `sendInvoice` / `sendDespatch`: recién aquí se envía (en producción tiene efecto tributario).
 *
 * Úsalo solo en un backend Node: necesita el certificado digital y las claves SOL. Una app móvil o de escritorio
 * debe llamar a ese backend, nunca firmar en el dispositivo.
 *
 * @example
 * ```ts
 * import { SunatClient, signingKeyFromPfx } from '@alonso804/sunat-sdk';
 * import { readFileSync } from 'node:fs';
 *
 * const client = new SunatClient({
 *   environment: 'production',
 *   issuer: {
 *     ruc: '20000000001',
 *     legalName: 'MI EMPRESA SAC',
 *     address: { ubigeo: '150101', department: 'LIMA', province: 'LIMA', district: 'LIMA', street: 'AV. PRINCIPAL 123' },
 *   },
 *   sol: { user: 'USUARIO1', password: process.env.SOL_PASSWORD! },
 *   gre: { clientId: process.env.GRE_CLIENT_ID!, clientSecret: process.env.GRE_CLIENT_SECRET! }, // solo para guías
 *   signingKey: signingKeyFromPfx(readFileSync('certificado.pfx'), process.env.CERT_PASSWORD!),
 * });
 * ```
 */
export class SunatClient {
  /** Datos del emisor ya validados y normalizados (con los valores por defecto aplicados). */
  readonly issuer: Issuer;
  /**
   * La configuración (clave SOL, `clientSecret`, llave privada) y el token van en campos privados de JavaScript (`#`):
   * a diferencia de `private` de TypeScript, no aparecen en `console.log`, `util.inspect` ni `JSON.stringify`, así que
   * no se filtran si alguien imprime o serializa el cliente.
   */
  readonly #config: SunatClientConfig;
  #greToken: Token | undefined;

  /**
   * Crea el cliente. No contacta a SUNAT: solo valida los datos del emisor.
   *
   * @param config - Ambiente, emisor, credenciales SOL (y de API, si emitirás guías), certificado y opciones de red.
   * @throws {SunatValidationError} Si los datos del emisor no son válidos (RUC, ubigeo, etc.); el detalle por campo
   *   está en `issues`.
   */
  constructor(config: SunatClientConfig) {
    this.#config = config;
    const parsed = IssuerSchema.safeParse(config.issuer);
    if (!parsed.success) throw toValidationError(parsed.error);
    this.issuer = config.textCharset === TextCharset.latin1 ? toLatin1Deep(parsed.data) : parsed.data;
  }

  /**
   * Valida la factura, calcula totales e IGV, genera el XML UBL 2.1 y lo firma. **No contacta a SUNAT.**
   * Muestra `summary` al usuario y pide confirmación antes de llamar a `sendInvoice`.
   *
   * @param input - Serie (`F` + 3 caracteres), correlativo, cliente (con RUC) e ítems. En cada ítem indica
   *   `unitPrice` (precio CON IGV) o `unitValue` (valor SIN IGV), no ambos. Opcional: moneda (`PEN` por defecto),
   *   forma de pago (`cash` por defecto, o `credit` con cuotas), orden de compra y guías relacionadas.
   * @returns La factura firmada (`signedXml`, `baseName`) y su `summary`: líneas, bases, IGV, total, monto en letras y
   *   cuotas ya calculadas.
   * @throws {SunatValidationError} Si un dato no es válido o la forma de pago no cuadra (las cuotas no suman el monto
   *   neto pendiente, un vencimiento no es posterior a la emisión…); el detalle por campo está en `issues`.
   *
   * @example
   * ```ts
   * const prepared = client.prepareInvoice({
   *   series: 'F001',
   *   number: 1,
   *   customer: { ruc: '20131312955', name: 'CLIENTE SAC' },
   *   items: [{ description: 'CEMENTO 42.5 KG', quantity: 10, unitPrice: 29.5 }],
   * });
   * prepared.summary.total; // "295.00"
   * ```
   */
  prepareInvoice(input: InvoiceInput): PreparedInvoice {
    const parsed = InvoiceSchema.safeParse(input);
    if (!parsed.success) throw toValidationError(parsed.error);
    const invoice = this.#config.textCharset === TextCharset.latin1 ? toLatin1Deep(parsed.data) : parsed.data;

    const issuedAt = invoice.issuedAt ?? this.#config.now?.() ?? new Date();
    const calculation = calculateInvoice(invoice);
    const payment = resolvePayment(invoice.payment, calculation.totals.payable, limaDateTime(issuedAt).date);
    const unsignedXml = buildInvoiceXml({ issuer: this.issuer, invoice, calculation, payment, issuedAt });
    const signedXml = signUblXml(
      unsignedXml,
      this.#config.signingKey,
      this.#config.signatureAlgorithm ?? SignatureAlgorithm.sha1,
    );
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
          payment.type === PaymentType.cash
            ? { type: PaymentType.cash }
            : {
                type: PaymentType.credit,
                netPending: fmt2(payment.netPending),
                installments: payment.installments.map((i) => ({
                  number: i.number,
                  dueDate: i.dueDate,
                  amount: fmt2(i.amount),
                })),
              },
        ...(invoice.purchaseOrder ? { purchaseOrder: invoice.purchaseOrder } : {}),
        relatedDespatches: invoice.relatedDespatches.map((d) => ({ type: d.type, number: `${d.series}-${d.number}` })),
      },
    };
  }

  /**
   * Envía a SUNAT una factura preparada con `prepareInvoice`. **En producción tiene efecto tributario.**
   *
   * - Aceptada (con o sin observaciones) o rechazada por validación: se devuelve el resultado.
   *   Un rechazo consume el correlativo (ver `SendInvoiceResult`).
   * - Excepción de SUNAT (`SunatFaultError` con `kind === SunatFaultKind.exception`): el comprobante quedó
   *   "no informado"; corrige y reenvía con el MISMO correlativo.
   * - Error de red (`SunatTransportError`): no se sabe si SUNAT lo recibió. NO generes otro
   *   correlativo: consulta su estado con `getInvoiceStatus` o reenvía el mismo comprobante.
   * - No envíes varias facturas en paralelo: el proxy de SUNAT puede responder 401. Los fallos que SUNAT con
   *   seguridad no procesó se reintentan solos (ver `SunatClientConfig.retry`).
   *
   * @param prepared - Resultado de `prepareInvoice`. No modifiques `signedXml`: invalidaría la firma.
   * @returns `accepted` / `accepted_with_observations` con el CDR (`cdrZip` es la constancia: guárdalo), o
   *   `rejected` con el código y el mensaje de SUNAT.
   * @throws {SunatFaultError} Excepción de SUNAT (0100–1999): el comprobante quedó "no informado"; corrige y reenvía
   *   con el mismo correlativo.
   * @throws {SunatTransportError} No se pudo completar el envío y no se sabe si SUNAT lo recibió.
   *
   * @example
   * ```ts
   * const result = await client.sendInvoice(prepared);
   * if (result.status === SendInvoiceStatus.rejected) console.error(result.code, result.message); // el número quedó consumido
   * else save(result.cdrZip);
   * ```
   */
  async sendInvoice(prepared: PreparedInvoice): Promise<SendInvoiceResult> {
    const { baseName } = prepared;
    const zip = zipSingleFile(`${baseName}.xml`, prepared.signedXml);

    let applicationResponse: string;
    try {
      applicationResponse = await withRetries(
        () =>
          sendBill({
            endpoint: ENDPOINTS[this.#config.environment].billService,
            auth: { username: `${this.issuer.ruc}${this.#config.sol.user}`, password: this.#config.sol.password },
            fileName: `${baseName}.zip`,
            zipBase64: Buffer.from(zip).toString('base64'),
            ...this.restOptions(),
          }),
        isSafeToResend,
        this.#config.retry,
      );
    } catch (error) {
      if (error instanceof SunatFaultError && error.kind === SunatFaultKind.rejected) {
        return { status: SendInvoiceStatus.rejected, baseName, code: error.code, message: error.sunatMessage };
      }
      throw error;
    }

    const { cdr, cdrZip } = readCdrFromApplicationResponse(applicationResponse);
    if (!cdr.accepted) {
      return { status: SendInvoiceStatus.rejected, baseName, code: cdr.responseCode, message: cdr.description };
    }
    return {
      status: cdr.notes.length > 0 ? SendInvoiceStatus.acceptedWithObservations : SendInvoiceStatus.accepted,
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
   *
   * @param query - Serie y correlativo del comprobante (siempre del emisor configurado) y su tipo (`01` por defecto).
   * @returns El código y el mensaje de SUNAT tal cual, y el CDR si SUNAT lo adjuntó.
   * @throws {SunatValidationError} Si la serie, el número o el tipo no son válidos.
   * @throws {SunatError} Si el cliente no está en `production` (SUNAT no ofrece esta consulta en beta).
   * @throws {SunatFaultError} Si SUNAT responde con una excepción (p. ej. usuario sin permiso de consulta).
   * @throws {SunatTransportError} Si la consulta falla por red tras los reintentos.
   *
   * @example
   * ```ts
   * const status = await client.getInvoiceStatus({ series: 'F001', number: 15 });
   * if (status.cdrZip) save(status.cdrZip);
   * ```
   */
  async getInvoiceStatus(query: InvoiceStatusQuery): Promise<InvoiceStatusResult> {
    const type = query.type ?? '01';
    const series = query.series.trim().toUpperCase();
    const issues: Array<{ path: string; message: string }> = [];
    if (!['01', '07', '08'].includes(type)) issues.push({ path: 'type', message: 'Debe ser 01, 07 u 08' });
    if (!/^[A-Z0-9]{4}$/.test(series))
      issues.push({ path: 'series', message: 'Debe tener 4 caracteres (letras o números)' });
    if (!Number.isInteger(query.number) || query.number < 1 || query.number > 99_999_999) {
      issues.push({ path: 'number', message: 'Debe ser un entero entre 1 y 99999999' });
    }
    if (issues.length > 0)
      throw new SunatValidationError('Los datos del comprobante a consultar no son válidos.', issues);

    const endpoint = ENDPOINTS[this.#config.environment].consultService;
    if (!endpoint) {
      throw new SunatError(
        `El servicio de consulta de CDR no está disponible en el ambiente "${this.#config.environment}": SUNAT solo lo publica para producción.`,
      );
    }
    const response = await withRetries(
      () =>
        getStatusCdr({
          endpoint,
          auth: { username: `${this.issuer.ruc}${this.#config.sol.user}`, password: this.#config.sol.password },
          query: { ruc: this.issuer.ruc, type, series, number: query.number },
          ...this.restOptions(),
        }),
      isRetryableRead,
      this.#config.retry,
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
   * Valida la guía de remisión remitente (GRE, tipo 09), genera su XML UBL 2.1 y lo firma. **No contacta a SUNAT.**
   * Muestra `summary` y `warnings` al usuario y pide confirmación antes de llamar a `sendDespatch`.
   *
   * @param input - Serie (`T` + 3 caracteres), correlativo, motivo de traslado (catálogo 20), destinatario, modalidad
   *   (`private`: vehículo y conductor propios; `public`: transportista), fecha de inicio del traslado, peso bruto,
   *   puntos de partida y llegada e ítems. El SDK valida las reglas de cada motivo (p. ej. el 04 exige los códigos de
   *   establecimiento).
   * @returns La guía firmada (`signedXml`, `baseName`), su `summary` y avisos para el usuario (`warnings`), por
   *   ejemplo hasta cuándo se puede dar de baja.
   * @throws {SunatValidationError} Si un dato no es válido o falta uno que exige el motivo o la modalidad; el detalle
   *   por campo está en `issues`.
   *
   * @example
   * ```ts
   * const prepared = client.prepareDespatch({
   *   series: 'T001',
   *   number: 1,
   *   reason: '01', // venta
   *   recipient: { docType: '6', docNumber: '20131312955', name: 'CLIENTE SAC' },
   *   transportMode: 'private',
   *   transferStartDate: '2026-11-04',
   *   grossWeight: { value: 425.5, unit: 'KGM' },
   *   origin: { ubigeo: '040106', address: 'MI ALMACEN' },
   *   destination: { ubigeo: '040101', address: 'OBRA DEL CLIENTE' },
   *   vehicle: { plate: 'ABC-123' },
   *   drivers: [{ docNumber: '12345678', firstName: 'JUAN', lastName: 'PEREZ', license: 'Q12345678' }],
   *   items: [{ description: 'CEMENTO SOL TIPO I 42.5 KG', quantity: 10 }],
   * });
   * console.log(prepared.summary, prepared.warnings);
   * ```
   */
  prepareDespatch(input: DespatchInput): PreparedDespatch {
    return prepareDespatch({
      issuer: this.issuer,
      input,
      signingKey: this.#config.signingKey,
      algorithm: this.#config.signatureAlgorithm ?? SignatureAlgorithm.sha1,
      now: this.#config.now ?? (() => new Date()),
      textCharset: this.#config.textCharset ?? TextCharset.unicode,
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
   *
   * @param prepared - Resultado de `prepareDespatch`. No modifiques `signedXml`: invalidaría la firma.
   * @param options - Espera del resultado (`pollIntervalMs`, `maxWaitMs`) y `downloadPdf: true` para bajar también el
   *   PDF oficial si queda aceptada (un fallo de esa descarga nunca convierte el envío en error: queda en `pdfError`).
   * @returns `accepted` / `accepted_with_observations` con el CDR (`cdrZip`: guárdalo, es el sustento del traslado) y
   *   `cdr.qrUrl` para el QR; `rejected` con el código y el mensaje; o `pending` con el `ticket`.
   * @throws {SunatValidationError} Si el cliente no tiene configuradas las credenciales de API (`gre`).
   * @throws {SunatApiError} Si SUNAT rechaza la petición antes de dar el ticket (credenciales, validación 422…).
   * @throws {SunatTransportError} Si falla la red antes de obtener el ticket.
   *
   * @example
   * ```ts
   * const result = await client.sendDespatch(prepared, { downloadPdf: true });
   * if (result.status === DespatchStatus.pending) saveForLater(result.baseName, result.ticket); // luego: getDespatchStatus
   * if (result.status === DespatchStatus.accepted || result.status === DespatchStatus.acceptedWithObservations) {
   *   save(result.cdrZip);
   *   const qrText = result.cdr.qrUrl; // texto que debe codificar el QR
   * }
   * ```
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
        this.#config.retry,
      ),
    );
    // Desde aquí SUNAT ya tiene la guía: un fallo al consultar el resultado no debe perder el ticket.
    let result: DespatchResult;
    try {
      result = await waitForDespatch(() => this.fetchTicket(receipt.ticket), baseName, receipt.ticket, options);
    } catch (error) {
      const statusError = error instanceof Error ? error : new Error(String(error));
      return { status: DespatchStatus.pending, baseName, ticket: receipt.ticket, statusError };
    }
    return this.attachPdf(result, options.downloadPdf);
  }

  /**
   * Consulta el resultado de una GRE ya enviada, a partir de su ticket (por ejemplo, tras un `pending` de
   * `sendDespatch`). Es de solo lectura: consulta una vez, con reintentos ante fallos pasajeros, sin esperar.
   *
   * @param ref - `baseName` y `ticket` del resultado `pending`.
   * @param options - `downloadPdf: true` para bajar también el PDF oficial si quedó aceptada.
   * @returns El mismo tipo de resultado que `sendDespatch`; `pending` si SUNAT sigue procesando.
   * @throws {SunatValidationError} Si el cliente no tiene configuradas las credenciales de API (`gre`).
   * @throws {SunatApiError} Si SUNAT responde con un error (credenciales, ticket inexistente…).
   * @throws {SunatTransportError} Si la consulta falla por red tras los reintentos (el ticket sigue sirviendo).
   *
   * @example
   * ```ts
   * const later = await client.getDespatchStatus({ baseName, ticket }, { downloadPdf: true });
   * ```
   */
  async getDespatchStatus(ref: DespatchTicketRef, options: DespatchStatusOptions = {}): Promise<DespatchResult> {
    // Consulta única (sin sondeo), pero con reintentos: es una lectura sin efecto.
    const fetchStatus = () => withRetries(() => this.fetchTicket(ref.ticket), isRetryableRead, this.#config.retry);
    const result = await waitForDespatch(fetchStatus, ref.baseName, ref.ticket, { maxWaitMs: 0 });
    return this.attachPdf(result, options.downloadPdf);
  }

  /** Baja el PDF oficial de una guía aceptada sin convertir un fallo de descarga en un error del envío. */
  private async attachPdf(result: DespatchResult, enabled: boolean | undefined): Promise<DespatchResult> {
    if (!enabled) return result;
    if (result.status !== DespatchStatus.accepted && result.status !== DespatchStatus.acceptedWithObservations)
      return result;
    const qrUrl = result.cdr.qrUrl;
    if (!qrUrl)
      return { ...result, pdfError: new SunatError('El CDR no trae la URL del QR; no hay PDF que descargar.') };
    try {
      return { ...result, pdf: await this.downloadDespatchPdf(qrUrl) };
    } catch (error) {
      return { ...result, pdfError: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /**
   * Descarga el PDF oficial de una GRE aceptada desde la URL del QR de su CDR (`cdr.qrUrl`). Sirve para reintentar
   * cuando `sendDespatch` con `downloadPdf` devolvió `pdfError`. No requiere credenciales.
   *
   * @param qrUrl - `cdr.qrUrl` de la guía aceptada. Solo se aceptan URLs https de `*.sunat.gob.pe`.
   * @param options - `retry`: reintentos ante fallos de red o 5xx (4 por defecto, con pausas que se duplican desde 0,5 s).
   * @returns El PDF (`pdf`) y el nombre de archivo que sugiere SUNAT (`fileName`), si es seguro.
   * @throws {SunatValidationError} Si la URL (o una redirección) no es https de sunat.gob.pe.
   * @throws {SunatApiError} Si SUNAT responde con un error o con algo que no es un PDF.
   * @throws {SunatTransportError} Si la descarga falla por red tras los reintentos.
   */
  async downloadDespatchPdf(qrUrl: string, options: DespatchPdfRetryOptions = {}): Promise<DespatchPdf> {
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
      ...(this.#config.fetch ? { fetch: this.#config.fetch } : {}),
      ...(this.#config.timeoutMs ? { timeoutMs: this.#config.timeoutMs } : {}),
    };
  }

  private requireGre(): GreCredentials {
    if (!this.#config.gre) {
      throw new SunatValidationError(
        'Para emitir guías configura `gre: { clientId, clientSecret }` (SOL → Credenciales de API SUNAT).',
      );
    }
    return this.#config.gre;
  }

  /** Usa el token en caché (se renueva 60 s antes de vencer) y reintenta una vez si SUNAT lo rechaza. */
  private async withGreToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    const now = this.#config.now ?? (() => new Date());
    const fresh = (): boolean => this.#greToken !== undefined && this.#greToken.expiresAt - 60_000 > now().getTime();
    const wasCached = fresh();

    if (!fresh()) this.#greToken = await this.newGreToken();
    try {
      return await call((this.#greToken as Token).accessToken);
    } catch (error) {
      if (wasCached && error instanceof SunatApiError && error.isAuthError) {
        this.#greToken = await this.newGreToken();
        return call(this.#greToken.accessToken);
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
            username: `${this.issuer.ruc}${this.#config.sol.user}`,
            password: this.#config.sol.password,
            ...(gre.authEndpoint ? { authEndpoint: gre.authEndpoint } : {}),
            ...this.restOptions(),
          },
          () => (this.#config.now ?? (() => new Date()))().getTime(),
        ),
      isRetryableRead,
      this.#config.retry,
    );
  }
}
