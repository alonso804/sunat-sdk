import { z } from 'zod';
import {
  IDENTITY_TYPES,
  RELATED_DOCUMENT_TYPES,
  SELF_RECIPIENT_REASONS,
  TRANSFER_REASONS,
  type IdentityType,
  type RelatedDocumentType,
  type TransferReason,
} from '../catalogs';
import { PositiveNumeric } from '../common-schema';
import { isValidRuc } from '../ruc';

const identityTypes = Object.keys(IDENTITY_TYPES) as [IdentityType, ...IdentityType[]];
const reasons = Object.keys(TRANSFER_REASONS) as [TransferReason, ...TransferReason[]];
const relatedTypes = Object.keys(RELATED_DOCUMENT_TYPES) as [RelatedDocumentType, ...RelatedDocumentType[]];

/** Persona o empresa identificada con un documento (destinatario, comprador, proveedor). */
export const DespatchPartySchema = z
  .object({
    /** Catálogo 06: 1 = DNI, 6 = RUC, 4 = carné de extranjería, 7 = pasaporte, A = cédula diplomática. */
    docType: z.enum(identityTypes),
    docNumber: z.string().min(1).max(15),
    name: z.string().min(1).max(250),
  })
  .superRefine((party, ctx) => {
    if (party.docType === '6' && !isValidRuc(party.docNumber)) {
      ctx.addIssue({ code: 'custom', path: ['docNumber'], message: 'RUC inválido' });
    }
    if (party.docType === '1' && !/^\d{8}$/.test(party.docNumber)) {
      ctx.addIssue({ code: 'custom', path: ['docNumber'], message: 'El DNI debe tener 8 dígitos' });
    }
  });

/** Punto de partida o de llegada. */
export const DespatchPointSchema = z.object({
  /** Ubigeo INEI de 6 dígitos (catálogo 13). */
  ubigeo: z.string().regex(/^\d{6}$/, 'El ubigeo debe tener 6 dígitos'),
  address: z.string().min(1).max(500),
  /** Código del establecimiento anexo (4 dígitos). Obligatorio en traslados entre establecimientos (motivo 04). */
  establishmentCode: z
    .string()
    .regex(/^\d{4}$/, 'El código de establecimiento tiene 4 dígitos')
    .optional(),
});

export const DespatchCarrierSchema = z.object({
  ruc: z.string().refine(isValidRuc, 'RUC del transportista inválido'),
  name: z.string().min(1).max(250),
  /** Número de registro MTC del transportista, si corresponde. */
  mtcRegistration: z.string().min(1).max(20).optional(),
});

export const DespatchVehicleSchema = z.object({
  /** Placa: 6 a 8 caracteres alfanuméricos; se normaliza a mayúsculas y sin guiones ni espacios. */
  plate: z
    .string()
    .transform((value) => value.toUpperCase().replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^[A-Z0-9]{6,8}$/, 'La placa debe tener entre 6 y 8 caracteres alfanuméricos')),
});

export const DespatchDriverSchema = z.object({
  kind: z.enum(['Principal', 'Secundario']).default('Principal'),
  docType: z.enum(identityTypes).default('1'),
  docNumber: z.string().min(1).max(15),
  firstName: z.string().min(1).max(250),
  lastName: z.string().min(1).max(250),
  /** Número de licencia de conducir (hasta 10 caracteres). */
  license: z.string().min(1).max(10),
});

export const DespatchItemSchema = z.object({
  /** Nombre y características del bien (marca, número de serie o de motor si lo tiene). */
  description: z.string().min(1).max(500),
  quantity: PositiveNumeric,
  /** Catálogo 03: NIU = unidad (bienes), KGM, MTR, LTR, etc. */
  unit: z
    .string()
    .regex(/^[A-Z0-9]{1,3}$/)
    .default('NIU'),
  code: z.string().min(1).max(30).optional(),
  /** Código de producto SUNAT (catálogo 25), hasta 8 dígitos. */
  sunatProductCode: z
    .string()
    .regex(/^\d{1,8}$/)
    .optional(),
  gtin: z
    .string()
    .regex(/^\d{8,14}$/)
    .optional(),
  /**
   * Indicador de bien regulado por SUNAT (catálogo 55, propiedad 7022). SOL lo escribe siempre en cada bien;
   * por defecto se declara `false` (valor 0). Márcalo `true` solo si el bien está regulado (p. ej. insumos
   * químicos o combustibles fiscalizados): declarar 0 en un bien regulado sería una declaración falsa.
   */
  regulated: z.boolean().optional(),
});

export const DespatchRelatedDocumentSchema = z.object({
  /** Catálogo 61: 01 = factura, 03 = boleta, 09 = GRE remitente, etc. */
  type: z.enum(relatedTypes),
  /** Serie y número, por ejemplo "F001-123". */
  number: z.string().min(1).max(100),
  issuerRuc: z.string().refine(isValidRuc, 'RUC del emisor inválido').optional(),
});

const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** Guía de remisión electrónica del remitente (GRE-remitente, tipo 09). */
export const DespatchSchema = z
  .object({
    /** Serie: "T" + 3 caracteres alfanuméricos, por ejemplo "T001". */
    series: z.string().regex(/^T[A-Z0-9]{3}$/, 'La serie de una GRE remitente es "T" + 3 caracteres, por ejemplo T001'),
    /** Correlativo (1 a 99 999 999), independiente del de las guías impresas. */
    number: z.number().int().min(1).max(99_999_999),
    /** Fecha y hora de emisión. Si se omite se usa la hora actual. */
    issuedAt: z.date().optional(),
    note: z.string().max(250).optional(),

    /** Catálogo 20: motivo del traslado. */
    reason: z.enum(reasons),
    /** Obligatorio si el motivo es "13" (otros). */
    reasonDescription: z.string().min(1).max(100).optional(),
    /**
     * Destinatario. En los motivos 02, 04 y 07 el destinatario es el propio remitente y
     * se completa solo; en los demás es obligatorio.
     */
    recipient: DespatchPartySchema.optional(),
    /** Comprador (obligatorio en el motivo 03: venta con entrega a terceros). */
    buyer: DespatchPartySchema.optional(),
    /** Proveedor (opcional en los motivos 02 y 07). */
    provider: DespatchPartySchema.optional(),

    /** "private" = transporte privado (vehículo propio), "public" = transportista de terceros. */
    transportMode: z.enum(['public', 'private']),
    /** Inicio del traslado (privado) o entrega de los bienes al transportista (público), "YYYY-MM-DD". */
    transferStartDate: z.string().refine(isCalendarDate, 'Fecha inválida; usa el formato YYYY-MM-DD'),
    /** Peso bruto total de la carga (incluye envases y embalajes). */
    grossWeight: z.object({
      value: PositiveNumeric,
      unit: z.enum(['KGM', 'TNE']).default('KGM'),
    }),
    /** Número de bultos o pallets. */
    packages: z.number().int().min(1).max(999_999).optional(),

    origin: DespatchPointSchema,
    destination: DespatchPointSchema,

    /** Transportista (obligatorio en transporte público, salvo vehículos M1/L). */
    carrier: DespatchCarrierSchema.optional(),
    /** Vehículo que realiza el traslado (obligatorio en transporte privado). */
    vehicle: DespatchVehicleSchema.optional(),
    /** Conductores (obligatorio en transporte privado; máximo 1 principal + 1 secundario). */
    drivers: z.array(DespatchDriverSchema).max(2).default([]),
    indicators: z
      .object({
        /** Traslado con transbordo programado. */
        plannedTransshipment: z.boolean().optional(),
        /** Traslado en vehículo de categoría M1 o L. */
        m1lVehicle: z.boolean().optional(),
        /** En transporte público, el remitente informa también vehículo y conductores del transportista. */
        carrierVehicleAndDrivers: z.boolean().optional(),
      })
      .default({}),

    items: z.array(DespatchItemSchema).min(1).max(500),
    relatedDocuments: z.array(DespatchRelatedDocumentSchema).max(20).default([]),
  })
  .superRefine((d, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });

    if (d.reason === '13' && !d.reasonDescription) {
      issue(['reasonDescription'], 'Con el motivo "13" (otros) debes describir el motivo del traslado');
    }
    if (d.reason === '03' && !d.buyer) {
      issue(['buyer'], 'Con el motivo "03" (venta con entrega a terceros) debes indicar el comprador');
    }
    if (!SELF_RECIPIENT_REASONS.includes(d.reason) && !d.recipient) {
      issue(['recipient'], 'Debes indicar el destinatario');
    }
    if (d.reason === '04') {
      if (!d.origin.establishmentCode) issue(['origin', 'establishmentCode'], 'El motivo "04" exige el código de establecimiento del punto de partida');
      if (!d.destination.establishmentCode) {
        issue(['destination', 'establishmentCode'], 'El motivo "04" exige el código de establecimiento del punto de llegada');
      }
    }

    if (d.transportMode === 'public') {
      if (!d.carrier && !d.indicators.m1lVehicle) {
        issue(['carrier'], 'En transporte público debes indicar el RUC y nombre del transportista');
      }
      if (d.indicators.carrierVehicleAndDrivers) {
        if (!d.vehicle) issue(['vehicle'], 'Con el indicador de vehículo y conductores del transportista debes indicar la placa');
        if (d.drivers.length === 0) issue(['drivers'], 'Con el indicador de vehículo y conductores del transportista debes indicar al menos un conductor');
      }
    } else if (!d.indicators.m1lVehicle) {
      // En vehículos M1/L (autos y motos) SOL no exige placa ni conductor; en el resto sí.
      if (!d.vehicle) issue(['vehicle'], 'En transporte privado debes indicar la placa del vehículo (salvo vehículos M1/L)');
      if (d.drivers.length === 0) issue(['drivers'], 'En transporte privado debes indicar al menos un conductor (salvo vehículos M1/L)');
    }
  });

export type DespatchInput = z.input<typeof DespatchSchema>;
export type Despatch = z.output<typeof DespatchSchema>;
export type DespatchItem = z.output<typeof DespatchItemSchema>;
