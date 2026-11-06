import {
  RELATED_DOCUMENT_TYPES,
  SELF_RECIPIENT_REASONS,
  TRANSFER_REASONS,
  type TransferReason,
  type TransportMode,
} from '../catalogs';
import { type Cdr, readCdrFromApplicationResponse } from '../cdr';
import { SunatApiError, SunatTransportError, SunatValidationError } from '../errors';
import type { TicketStatus } from '../gre/api';
import type { DespatchPdf } from '../gre/pdf';
import type { Issuer } from '../invoice/schema';
import { dec, fmtFixed, fmtUpTo } from '../money';
import type { SigningKey } from '../signing/certificate';
import { extractDigestValue, type SignatureAlgorithm, signUblXml } from '../signing/xmldsig';
import { TextCharset, toLatin1Deep } from '../text-charset';
import { toValidationError } from '../validation';
import { limaDateTime } from '../xml';
import { type DespatchInput, DespatchSchema } from './schema';
import { buildDespatchXml, despatchBaseName, type ResolvedParty } from './xml';

/** Resumen legible para mostrar al usuario y pedir confirmación antes de emitir. */
export type DespatchSummary = {
  series: string;
  number: number;
  /** Hora de Lima, `YYYY-MM-DD HH:mm:ss`. */
  issuedAt: string;
  /** Motivo de traslado (catálogo 20) con su descripción, p. ej. `{ code: '01', label: 'Venta' }`. */
  reason: { code: TransferReason; label: string };
  transportMode: TransportMode;
  /** `YYYY-MM-DD`: inicio del traslado (privado) o entrega al transportista (público). */
  transferStartDate: string;
  /** Destinatario ya resuelto: en los motivos 02, 04 y 07 es el propio remitente. */
  recipient: ResolvedParty;
  /** Punto de partida. */
  origin: { ubigeo: string; address: string };
  /** Punto de llegada. */
  destination: { ubigeo: string; address: string };
  /** Por ejemplo "12.500 KGM". */
  grossWeight: string;
  /** Número de bultos, si se indicó. */
  packages: number | undefined;
  items: Array<{ description: string; quantity: string; unit: string }>;
  /** Transportista (transporte público). */
  carrier: { ruc: string; name: string } | undefined;
  /** Placa del vehículo: en transporte privado, o en público con el indicador `carrierVehicleAndDrivers`. */
  vehiclePlate: string | undefined;
  /** Conductores: en transporte privado, o en público con el indicador `carrierVehicleAndDrivers`. */
  drivers: Array<{ name: string; docNumber: string; license: string }>;
  /** Documentos relacionados (p. ej. la factura que sustenta la venta), con la descripción de su tipo. */
  relatedDocuments: Array<{ type: string; label: string; number: string }>;
};

/** GRE validada y firmada, lista para enviarse. No tiene efecto hasta que se envía. */
export type PreparedDespatch = {
  /** `<RUC>-09-<SERIE>-<CORRELATIVO>`: nombre de los archivos XML y ZIP. */
  baseName: string;
  /** XML UBL 2.1 firmado, tal como se enviará. Guárdalo junto al CDR. */
  signedXml: string;
  /** Hash (DigestValue) del documento firmado. (El QR no se arma con él: SUNAT entrega la URL del QR en el CDR, `cdr.qrUrl`.) */
  digestValue: string | undefined;
  /** Fecha y hora de emisión que lleva el XML. */
  issuedAt: Date;
  /** Resumen para mostrar al usuario y pedir confirmación antes de `sendDespatch`. */
  summary: DespatchSummary;
  /** Avisos para el usuario antes de confirmar el envío. */
  warnings: string[];
};

/**
 * Estados de `DespatchResult`. Es un objeto `as const` y a la vez un tipo con el mismo nombre (como las clases de
 * error): `DespatchStatus.pending` es el valor y `DespatchStatus` la unión de todos.
 */
export const DespatchStatus = {
  /** Aceptada: ya se puede iniciar el traslado. Guarda el CDR. */
  accepted: 'accepted',
  /** Aceptada con observaciones (en `cdr.notes`): también se puede iniciar el traslado. */
  acceptedWithObservations: 'accepted_with_observations',
  /** Rechazada: en guías el rechazo no invalida el número; corrige y reenvía. */
  rejected: 'rejected',
  /** SUNAT ya la recibió pero aún no se conoce el resultado: consulta con `getDespatchStatus`; no la reenvíes. */
  pending: 'pending',
} as const;
export type DespatchStatus = (typeof DespatchStatus)[keyof typeof DespatchStatus];

/**
 * Resultado de `sendDespatch` y `getDespatchStatus`, según `status` (ver `DespatchStatus`). Una vez que SUNAT entrega
 * el ticket ya no se lanzan errores: lo que falle después llega como `pending` con `statusError`.
 */
export type DespatchResult =
  | {
      /** Aceptada, con o sin observaciones (las observaciones están en `cdr.notes`). */
      status: typeof DespatchStatus.accepted | typeof DespatchStatus.acceptedWithObservations;
      /** `<RUC>-09-<SERIE>-<CORRELATIVO>`. */
      baseName: string;
      /** Ticket que devolvió SUNAT al recibir la guía. */
      ticket: string;
      /** CDR ya interpretado; `cdr.qrUrl` es el texto del QR. */
      cdr: Cdr;
      /** CDR tal como lo devolvió SUNAT (ZIP). Es el sustento del traslado: guárdalo. */
      cdrZip: Uint8Array;
      /** PDF oficial de SUNAT, solo si se pidió `downloadPdf` y la descarga funcionó. Guárdalo junto al CDR. */
      pdf?: DespatchPdf;
      /** Por qué no se pudo bajar el PDF (la guía igual quedó aceptada). Reintenta con `downloadDespatchPdf(cdr.qrUrl)`. */
      pdfError?: Error;
    }
  | {
      /** SUNAT procesó el envío y lo rechazó. En guías el rechazo no invalida el número. */
      status: typeof DespatchStatus.rejected;
      /** `<RUC>-09-<SERIE>-<CORRELATIVO>`. */
      baseName: string;
      /** Ticket que devolvió SUNAT al recibir la guía. */
      ticket: string;
      /** Código de error de SUNAT. */
      code: string;
      /** Mensaje de SUNAT que explica el rechazo. */
      message: string;
      /** CDR del rechazo, si SUNAT lo generó. */
      cdr?: Cdr;
    }
  | {
      /**
       * SUNAT ya recibió la guía (hay ticket), pero aún no se conoce el resultado: seguía procesando al agotarse la
       * espera o falló la consulta (ver `statusError`). Consulta de nuevo con `getDespatchStatus({ baseName, ticket })`;
       * NO la reenvíes con otro número.
       */
      status: typeof DespatchStatus.pending;
      /** `<RUC>-09-<SERIE>-<CORRELATIVO>`. */
      baseName: string;
      /** Ticket para consultar con `getDespatchStatus`. Guárdalo. */
      ticket: string;
      /** Solo si la consulta del ticket falló (red, error de SUNAT, CDR ilegible). La guía igual quedó recibida. */
      statusError?: Error;
    };

/** Opciones de `sendDespatch`: cuánto esperar el resultado del ticket y si bajar el PDF oficial. */
export type DespatchSendOptions = {
  /** Pausa entre consultas del ticket. Por defecto 2000 ms. */
  pollIntervalMs?: number;
  /** Espera máxima por el resultado. Por defecto 60 000 ms. */
  maxWaitMs?: number;
  /**
   * Al quedar aceptada la guía, descarga también el PDF oficial de SUNAT (desde `cdr.qrUrl`) y lo devuelve en
   * `pdf`. Si la descarga falla, la guía sigue aceptada y el motivo queda en `pdfError`: nunca lanza error.
   */
  downloadPdf?: boolean;
  /** Inyectables para pruebas. */
  sleep?: (ms: number) => Promise<void>;
  /** Reloj en milisegundos, inyectable para pruebas (por defecto `Date.now`). */
  now?: () => number;
};

export function prepareDespatch(params: {
  issuer: Issuer;
  input: DespatchInput;
  signingKey: SigningKey;
  algorithm: SignatureAlgorithm;
  now: () => Date;
  /** Ver `SunatClientConfig.textCharset`. Por defecto `unicode`. */
  textCharset?: TextCharset;
}): PreparedDespatch {
  const { issuer, input, signingKey, algorithm } = params;
  const parsed = DespatchSchema.safeParse(input);
  if (!parsed.success) throw toValidationError(parsed.error);
  const d = params.textCharset === TextCharset.latin1 ? toLatin1Deep(parsed.data) : parsed.data;

  const issuedAt = d.issuedAt ?? params.now();
  const issued = limaDateTime(issuedAt);

  const selfRecipient: ResolvedParty = { docType: '6', docNumber: issuer.ruc, name: issuer.legalName };
  const mustBeSelf = SELF_RECIPIENT_REASONS.includes(d.reason);
  if (mustBeSelf && d.recipient && (d.recipient.docType !== '6' || d.recipient.docNumber !== issuer.ruc)) {
    throw new SunatValidationError(
      `Datos inválidos: recipient: con el motivo "${d.reason}" (${TRANSFER_REASONS[d.reason]}) el destinatario es el propio remitente`,
      [{ path: 'recipient', message: 'El destinatario debe ser el propio remitente' }],
    );
  }
  const recipient: ResolvedParty = mustBeSelf ? selfRecipient : (d.recipient as ResolvedParty);

  if (d.transferStartDate < issued.date) {
    throw new SunatValidationError('Datos inválidos: transferStartDate: no puede ser anterior a la fecha de emisión', [
      { path: 'transferStartDate', message: 'No puede ser anterior a la fecha de emisión' },
    ]);
  }

  const warnings: string[] = [];
  if (d.transferStartDate === issued.date) {
    warnings.push(
      'El traslado inicia hoy. Una vez iniciado ya no se puede dar de baja la GRE en SOL (art. 8 de la RS 000123-2022/SUNAT).',
    );
  } else {
    warnings.push(
      'Mientras el traslado no haya iniciado, la GRE se puede dar de baja en SOL (art. 8 de la RS 000123-2022/SUNAT).',
    );
  }
  if (recipient.docType === '6' && recipient.docNumber !== issuer.ruc) {
    warnings.push(
      'El destinatario recibirá un aviso en su Buzón SOL y podrá declarar su no conformidad (art. 9 de la RS 000123-2022/SUNAT).',
    );
  }

  const unsignedXml = buildDespatchXml({ issuer, despatch: d, recipient, issuedAt });
  const signedXml = signUblXml(unsignedXml, signingKey, algorithm);

  return {
    baseName: despatchBaseName(issuer.ruc, d),
    signedXml,
    digestValue: extractDigestValue(signedXml),
    issuedAt,
    warnings,
    summary: {
      series: d.series,
      number: d.number,
      issuedAt: `${issued.date} ${issued.time}`,
      reason: { code: d.reason, label: TRANSFER_REASONS[d.reason] },
      transportMode: d.transportMode,
      transferStartDate: d.transferStartDate,
      recipient,
      origin: { ubigeo: d.origin.ubigeo, address: d.origin.address },
      destination: { ubigeo: d.destination.ubigeo, address: d.destination.address },
      grossWeight: `${fmtFixed(dec(d.grossWeight.value), 3)} ${d.grossWeight.unit}`,
      packages: d.packages,
      items: d.items.map((item) => ({
        description: item.description,
        quantity: fmtUpTo(dec(item.quantity), 10),
        unit: item.unit,
      })),
      carrier: d.carrier ? { ruc: d.carrier.ruc, name: d.carrier.name } : undefined,
      vehiclePlate: d.vehicle?.plate,
      drivers: d.drivers.map((driver) => ({
        name: `${driver.firstName} ${driver.lastName}`,
        docNumber: driver.docNumber,
        license: driver.license,
      })),
      relatedDocuments: d.relatedDocuments.map((doc) => ({
        type: doc.type,
        label: RELATED_DOCUMENT_TYPES[doc.type],
        number: doc.number,
      })),
    },
  };
}

/** Interpreta la respuesta de la consulta de un ticket. */
export function mapTicketStatus(baseName: string, ticket: string, status: TicketStatus): DespatchResult {
  switch (status.code) {
    case '98':
      return { status: DespatchStatus.pending, baseName, ticket };

    case '0': {
      if (!status.cdrBase64) {
        throw new SunatApiError('SUNAT indicó que el envío fue procesado, pero no devolvió el CDR.', 200);
      }
      const { cdr, cdrZip } = readCdrFromApplicationResponse(status.cdrBase64);
      if (!cdr.accepted) {
        return {
          status: DespatchStatus.rejected,
          baseName,
          ticket,
          code: cdr.responseCode,
          message: cdr.description,
          cdr,
        };
      }
      return {
        status: cdr.notes.length > 0 ? DespatchStatus.acceptedWithObservations : DespatchStatus.accepted,
        baseName,
        ticket,
        cdr,
        cdrZip,
      };
    }

    case '99': {
      let cdr: Cdr | undefined;
      if (status.cdrBase64) {
        try {
          cdr = readCdrFromApplicationResponse(status.cdrBase64).cdr;
        } catch {
          cdr = undefined; // el error principal viene en `status.error`
        }
      }
      return {
        status: DespatchStatus.rejected,
        baseName,
        ticket,
        code: status.error?.number || cdr?.responseCode || '99',
        message: status.error?.description || cdr?.description || 'SUNAT procesó el envío con errores.',
        ...(cdr ? { cdr } : {}),
      };
    }

    default:
      throw new SunatApiError(`Código de respuesta desconocido al consultar el ticket: "${status.code}".`, 200);
  }
}

/** Fallo pasajero al consultar el ticket (red, 408/429/5xx): no decide nada, conviene volver a consultar. */
function isTransient(error: unknown): boolean {
  return error instanceof SunatTransportError || (error instanceof SunatApiError && error.retryable);
}

/**
 * Consulta el ticket hasta que SUNAT termine de procesar o se agote la espera.
 * Un fallo pasajero de la consulta se reintenta mientras quede tiempo; si persiste al vencer la espera, se lanza.
 */
export async function waitForDespatch(
  fetchStatus: () => Promise<TicketStatus>,
  baseName: string,
  ticket: string,
  options: DespatchSendOptions = {},
): Promise<DespatchResult> {
  const interval = options.pollIntervalMs ?? 2_000;
  const maxWait = options.maxWaitMs ?? 60_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + maxWait;

  for (;;) {
    try {
      const result = mapTicketStatus(baseName, ticket, await fetchStatus());
      if (result.status !== DespatchStatus.pending || now() >= deadline) return result;
    } catch (error) {
      if (!isTransient(error) || now() >= deadline) throw error;
    }
    await sleep(interval);
  }
}
