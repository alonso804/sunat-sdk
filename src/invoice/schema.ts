import { z } from 'zod';
import { PositiveNumeric } from '../common-schema';
import { isValidRuc } from '../ruc';

export const AddressSchema = z.object({
  /** Código de ubigeo INEI de 6 dígitos (departamento + provincia + distrito). */
  ubigeo: z.string().regex(/^\d{6}$/, 'El ubigeo debe tener 6 dígitos'),
  department: z.string().min(1),
  province: z.string().min(1),
  district: z.string().min(1),
  street: z.string().min(1).max(200),
  urbanization: z.string().max(100).optional(),
  /** Código del establecimiento anexo; "0000" es el domicilio fiscal. */
  establishmentCode: z.string().regex(/^\d{4}$/).default('0000'),
  countryCode: z.string().length(2).default('PE'),
});

/** Datos del contribuyente que emite (el titular del RUC). */
export const IssuerSchema = z.object({
  ruc: z.string().refine(isValidRuc, 'RUC inválido'),
  legalName: z.string().min(1).max(200),
  tradeName: z.string().max(200).optional(),
  address: AddressSchema,
  email: z.string().email().optional(),
  phone: z.string().max(30).optional(),
});

export const InvoiceCustomerSchema = z.object({
  /** Las facturas solo se emiten a clientes con RUC. */
  ruc: z.string().refine(isValidRuc, 'RUC del cliente inválido'),
  name: z.string().min(1).max(200),
  address: z.string().max(200).optional(),
});

export const InvoiceItemSchema = z
  .object({
    description: z.string().min(1).max(250),
    quantity: PositiveNumeric,
    /** Catálogo 03 (unidad de medida): NIU = unidad (bienes), ZZ = unidad (servicios), KGM, MTR, etc. */
    unit: z
      .string()
      .regex(/^[A-Z0-9]{1,3}$/)
      .default('NIU'),
    /** Precio unitario CON IGV (como se cotiza al público). */
    unitPrice: PositiveNumeric.optional(),
    /** Valor unitario SIN IGV. */
    unitValue: PositiveNumeric.optional(),
    /** Catálogo 07: 10 = gravado, 20 = exonerado, 30 = inafecto. */
    igvAffectation: z.enum(['10', '20', '30']).default('10'),
    /** Código interno del producto. */
    productCode: z.string().max(30).optional(),
  })
  .refine((item) => (item.unitPrice === undefined) !== (item.unitValue === undefined), {
    message: 'Indica unitPrice (con IGV) o unitValue (sin IGV), pero no ambos',
  });

const isCalendarDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** Una cuota del crédito. Si omites `amount` en todas, el SDK reparte el monto neto pendiente en partes iguales. */
export const InstallmentSchema = z.object({
  /** Fecha de vencimiento `YYYY-MM-DD`. */
  dueDate: z.string().refine(isCalendarDate, 'Debe ser una fecha válida YYYY-MM-DD'),
  amount: PositiveNumeric.optional(),
});

/**
 * Forma de pago (SUNAT exige indicar contado o crédito; RS 193-2020/SUNAT, anexo 9-A).
 * - `cash`: al contado (por defecto).
 * - `credit`: al crédito. El monto neto pendiente es, por defecto, el TOTAL de la factura (el caso habitual:
 *   no hace falta volver a escribirlo); si indicas otro, no puede ser mayor al total. Máximo 60 cuotas.
 */
export const InvoicePaymentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cash') }),
  z.object({
    type: z.literal('credit'),
    netPending: PositiveNumeric.optional(),
    installments: z.array(InstallmentSchema).min(1).max(60),
  }),
]);

/** Guía de remisión relacionada con la operación que se factura. */
export const RelatedDespatchSchema = z.object({
  /** Serie de la guía, p. ej. "T001" (o "EG07" si se emitió en SOL). */
  series: z.string().transform((v) => v.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'La serie debe tener 4 caracteres')),
  number: z.number().int().min(1).max(99_999_999),
  /** Catálogo 01: 09 = guía de remisión remitente (por defecto), 31 = guía de remisión transportista. */
  type: z.enum(['09', '31']).default('09'),
});

export const InvoiceSchema = z.object({
  /** Serie de la factura: F + 3 caracteres, por ejemplo "F001". */
  series: z.string().regex(/^F[A-Z0-9]{3}$/, 'La serie de una factura es "F" + 3 caracteres, por ejemplo F001'),
  /** Correlativo (1 a 99 999 999). */
  number: z.number().int().min(1).max(99_999_999),
  /** Fecha y hora de emisión. Si se omite se usa la hora actual. */
  issuedAt: z.date().optional(),
  currency: z.enum(['PEN', 'USD']).default('PEN'),
  /** Catálogo 51: 0101 = venta interna. */
  operationType: z
    .string()
    .regex(/^\d{4}$/)
    .default('0101'),
  customer: InvoiceCustomerSchema,
  items: z.array(InvoiceItemSchema).min(1).max(500),
  /** Observaciones libres que se imprimen en el comprobante. */
  note: z.string().max(500).optional(),
  /** Forma de pago. Por defecto al contado. */
  payment: InvoicePaymentSchema.default({ type: 'cash' }),
  /** Número de la orden de compra del cliente (hasta 20 caracteres). */
  purchaseOrder: z.string().trim().min(1).max(20).optional(),
  /** Guías de remisión relacionadas con la operación (0 o más). */
  relatedDespatches: z.array(RelatedDespatchSchema).max(20).default([]),
});

export type IssuerInput = z.input<typeof IssuerSchema>;
export type Issuer = z.output<typeof IssuerSchema>;
export type InvoiceInput = z.input<typeof InvoiceSchema>;
export type Invoice = z.output<typeof InvoiceSchema>;
export type InvoiceItem = z.output<typeof InvoiceItemSchema>;
export type InvoicePayment = z.output<typeof InvoicePaymentSchema>;
export type RelatedDespatch = z.output<typeof RelatedDespatchSchema>;
