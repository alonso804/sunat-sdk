import { z } from 'zod';
import {
  IDENTITY_TYPES,
  type IdentityType,
  RELATED_DOCUMENT_TYPES,
  type RelatedDocumentType,
  SELF_RECIPIENT_REASONS,
  TRANSFER_REASONS,
  type TransferReason,
  TransportMode,
} from '../catalogs';
import { PositiveNumeric } from '../common-schema';
import { isValidRuc } from '../ruc';

// Cada schema se arma con una constante de forma (`…Shape`) y se anota con `z.ZodObject<typeof …Shape>`: así el .d.ts
// publicado apunta a la forma y conserva los comentarios de cada campo, que se ven al autocompletar desde otro proyecto.
// (Si el tipo se infiere, TypeScript lo reescribe campo por campo en el .d.ts y los comentarios se pierden.)

const identityTypes = Object.keys(IDENTITY_TYPES) as [IdentityType, ...IdentityType[]];
const reasons = Object.keys(TRANSFER_REASONS) as [TransferReason, ...TransferReason[]];
const relatedTypes = Object.keys(RELATED_DOCUMENT_TYPES) as [RelatedDocumentType, ...RelatedDocumentType[]];

const despatchPartyShape = {
  /** Catálogo 06: 1 = DNI, 6 = RUC, 4 = carné de extranjería, 7 = pasaporte, A = cédula diplomática. */
  docType: z.enum(identityTypes),
  /** Número del documento: RUC de 11 dígitos (con dígito verificador), DNI de 8 dígitos, etc. */
  docNumber: z.string().min(1).max(15),
  /** Nombre o razón social (hasta 250 caracteres). */
  name: z.string().min(1).max(250),
};
/** Persona o empresa identificada con un documento (destinatario, comprador, proveedor). */
export const DespatchPartySchema: z.ZodObject<typeof despatchPartyShape> = z
  .object(despatchPartyShape)
  .superRefine((party, ctx) => {
    if (party.docType === '6' && !isValidRuc(party.docNumber)) {
      ctx.addIssue({ code: 'custom', path: ['docNumber'], message: 'RUC inválido' });
    }
    if (party.docType === '1' && !/^\d{8}$/.test(party.docNumber)) {
      ctx.addIssue({ code: 'custom', path: ['docNumber'], message: 'El DNI debe tener 8 dígitos' });
    }
  });

const despatchPointShape = {
  /** Ubigeo INEI de 6 dígitos (catálogo 13). */
  ubigeo: z.string().regex(/^\d{6}$/, 'El ubigeo debe tener 6 dígitos'),
  /** Dirección del punto (hasta 500 caracteres). */
  address: z.string().min(1).max(500),
  /** Código del establecimiento anexo (4 dígitos). Obligatorio en traslados entre establecimientos (motivo 04). */
  establishmentCode: z
    .string()
    .regex(/^\d{4}$/, 'El código de establecimiento tiene 4 dígitos')
    .optional(),
};
/** Punto de partida o de llegada. */
export const DespatchPointSchema: z.ZodObject<typeof despatchPointShape> = z.object(despatchPointShape);

const despatchCarrierShape = {
  /** RUC del transportista. */
  ruc: z.string().refine(isValidRuc, 'RUC del transportista inválido'),
  /** Razón social del transportista (hasta 250 caracteres). */
  name: z.string().min(1).max(250),
  /** Número de registro MTC del transportista, si corresponde. */
  mtcRegistration: z.string().min(1).max(20).optional(),
};
/** Transportista, en transporte público. */
export const DespatchCarrierSchema: z.ZodObject<typeof despatchCarrierShape> = z.object(despatchCarrierShape);

const despatchVehicleShape = {
  /** Placa: 6 a 8 caracteres alfanuméricos; se normaliza a mayúsculas y sin guiones ni espacios. */
  plate: z
    .string()
    .transform((value) => value.toUpperCase().replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^[A-Z0-9]{6,8}$/, 'La placa debe tener entre 6 y 8 caracteres alfanuméricos')),
};
/** Vehículo que realiza el traslado. */
export const DespatchVehicleSchema: z.ZodObject<typeof despatchVehicleShape> = z.object(despatchVehicleShape);

const despatchDriverShape = {
  /** Conductor principal o secundario (por defecto, principal). */
  kind: z.enum(['Principal', 'Secundario']).default('Principal'),
  /** Catálogo 06: tipo de documento del conductor (por defecto 1 = DNI). */
  docType: z.enum(identityTypes).default('1'),
  /** Número de documento del conductor. */
  docNumber: z.string().min(1).max(15),
  /** Nombres del conductor. */
  firstName: z.string().min(1).max(250),
  /** Apellidos del conductor. */
  lastName: z.string().min(1).max(250),
  /** Número de licencia de conducir (hasta 10 caracteres). */
  license: z.string().min(1).max(10),
};
/** Conductor del vehículo. */
export const DespatchDriverSchema: z.ZodObject<typeof despatchDriverShape> = z.object(despatchDriverShape);

const despatchItemShape = {
  /** Nombre y características del bien (marca, número de serie o de motor si lo tiene). */
  description: z.string().min(1).max(500),
  /** Cantidad: número o texto decimal (p. ej. 10 o "2.5"). */
  quantity: PositiveNumeric,
  /** Catálogo 03: NIU = unidad (bienes), KGM, MTR, LTR, etc. */
  unit: z
    .string()
    .regex(/^[A-Z0-9]{1,3}$/)
    .default('NIU'),
  /** Código interno del bien (opcional, hasta 30 caracteres). */
  code: z.string().min(1).max(30).optional(),
  /** Código de producto SUNAT (catálogo 25), hasta 8 dígitos. */
  sunatProductCode: z
    .string()
    .regex(/^\d{1,8}$/)
    .optional(),
  /** Código GTIN del bien, de 8 a 14 dígitos (opcional). */
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
};
/** Un bien trasladado. */
export const DespatchItemSchema: z.ZodObject<typeof despatchItemShape> = z.object(despatchItemShape);

const despatchRelatedDocumentShape = {
  /** Catálogo 61: 01 = factura, 03 = boleta, 09 = GRE remitente, etc. */
  type: z.enum(relatedTypes),
  /** Serie y número, por ejemplo "F001-123". */
  number: z.string().min(1).max(100),
  /** RUC de quien emitió el documento relacionado (opcional). */
  issuerRuc: z.string().refine(isValidRuc, 'RUC del emisor inválido').optional(),
};
/** Documento relacionado con el traslado (p. ej. la factura que sustenta la venta). */
export const DespatchRelatedDocumentSchema: z.ZodObject<typeof despatchRelatedDocumentShape> =
  z.object(despatchRelatedDocumentShape);

const grossWeightShape = {
  /** Peso bruto, en la unidad indicada. */
  value: PositiveNumeric,
  /** KGM = kilogramos (por defecto), TNE = toneladas. */
  unit: z.enum(['KGM', 'TNE']).default('KGM'),
};
const GrossWeightSchema: z.ZodObject<typeof grossWeightShape> = z.object(grossWeightShape);

const indicatorsShape = {
  /** Traslado con transbordo programado. */
  plannedTransshipment: z.boolean().optional(),
  /** Traslado en vehículo de categoría M1 o L. */
  m1lVehicle: z.boolean().optional(),
  /** En transporte público, el remitente informa también vehículo y conductores del transportista. */
  carrierVehicleAndDrivers: z.boolean().optional(),
};
const IndicatorsSchema: z.ZodObject<typeof indicatorsShape> = z.object(indicatorsShape);

const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const despatchShape = {
  /** Serie: "T" + 3 caracteres alfanuméricos, por ejemplo "T001". */
  series: z.string().regex(/^T[A-Z0-9]{3}$/, 'La serie de una GRE remitente es "T" + 3 caracteres, por ejemplo T001'),
  /** Correlativo (1 a 99 999 999), independiente del de las guías impresas. */
  number: z.number().int().min(1).max(99_999_999),
  /** Fecha y hora de emisión. Si se omite se usa la hora actual. */
  issuedAt: z.date().optional(),
  /** Observaciones (opcional, hasta 250 caracteres). */
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
  transportMode: z.enum(TransportMode),
  /** Inicio del traslado (privado) o entrega de los bienes al transportista (público), "YYYY-MM-DD". */
  transferStartDate: z.string().refine(isCalendarDate, 'Fecha inválida; usa el formato YYYY-MM-DD'),
  /** Peso bruto total de la carga (incluye envases y embalajes). */
  grossWeight: GrossWeightSchema,
  /** Número de bultos o pallets. */
  packages: z.number().int().min(1).max(999_999).optional(),

  /** Punto de partida. */
  origin: DespatchPointSchema,
  /** Punto de llegada. */
  destination: DespatchPointSchema,

  /** Transportista (obligatorio en transporte público, salvo vehículos M1/L). */
  carrier: DespatchCarrierSchema.optional(),
  /** Vehículo que realiza el traslado (obligatorio en transporte privado). */
  vehicle: DespatchVehicleSchema.optional(),
  /** Conductores (obligatorio en transporte privado; máximo 1 principal + 1 secundario). */
  drivers: z.array(DespatchDriverSchema).max(2).default([]),
  /** Indicadores especiales del traslado (opcionales). */
  indicators: IndicatorsSchema.default({}),

  /** Bienes trasladados (1 a 500). */
  items: z.array(DespatchItemSchema).min(1).max(500),
  /** Documentos relacionados (p. ej. la factura que sustenta la venta), hasta 20. */
  relatedDocuments: z.array(DespatchRelatedDocumentSchema).max(20).default([]),
};

/**
 * Schema zod de la guía de remisión electrónica del remitente (GRE remitente, tipo 09), con las reglas de cada motivo
 * y modalidad. `prepareDespatch` ya lo aplica; úsalo si quieres validar un formulario antes de preparar la guía.
 */
export const DespatchSchema: z.ZodObject<typeof despatchShape> = z.object(despatchShape).superRefine((d, ctx) => {
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
    if (!d.origin.establishmentCode)
      issue(['origin', 'establishmentCode'], 'El motivo "04" exige el código de establecimiento del punto de partida');
    if (!d.destination.establishmentCode) {
      issue(
        ['destination', 'establishmentCode'],
        'El motivo "04" exige el código de establecimiento del punto de llegada',
      );
    }
  }

  if (d.transportMode === TransportMode.public) {
    if (!d.carrier && !d.indicators.m1lVehicle) {
      issue(['carrier'], 'En transporte público debes indicar el RUC y nombre del transportista');
    }
    if (d.indicators.carrierVehicleAndDrivers) {
      if (!d.vehicle)
        issue(['vehicle'], 'Con el indicador de vehículo y conductores del transportista debes indicar la placa');
      if (d.drivers.length === 0)
        issue(
          ['drivers'],
          'Con el indicador de vehículo y conductores del transportista debes indicar al menos un conductor',
        );
    }
  } else if (!d.indicators.m1lVehicle) {
    // En vehículos M1/L (autos y motos) SOL no exige placa ni conductor; en el resto sí.
    if (!d.vehicle)
      issue(['vehicle'], 'En transporte privado debes indicar la placa del vehículo (salvo vehículos M1/L)');
    if (d.drivers.length === 0)
      issue(['drivers'], 'En transporte privado debes indicar al menos un conductor (salvo vehículos M1/L)');
  }
});

/** Guía tal como la pasas a `prepareDespatch` (campos opcionales y valores por defecto sin aplicar). */
export type DespatchInput = z.input<typeof DespatchSchema>;
/** Guía ya validada, con los valores por defecto aplicados. */
export type Despatch = z.output<typeof DespatchSchema>;
export type DespatchItem = z.output<typeof DespatchItemSchema>;
