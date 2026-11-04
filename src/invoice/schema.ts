import { z } from 'zod';
import { Currency } from '../catalogs';
import { PositiveNumeric } from '../common-schema';
import { isValidRuc } from '../ruc';

// Cada schema se arma con una constante de forma (`…Shape`) y se anota con `z.ZodObject<typeof …Shape>`: así el .d.ts
// publicado apunta a la forma y conserva los comentarios de cada campo, que se ven al autocompletar desde otro proyecto.
// (Si el tipo se infiere, TypeScript lo reescribe campo por campo en el .d.ts y los comentarios se pierden.)

const addressShape = {
  /** Código de ubigeo INEI de 6 dígitos (departamento + provincia + distrito). */
  ubigeo: z.string().regex(/^\d{6}$/, 'El ubigeo debe tener 6 dígitos'),
  /** Departamento, como figura en la Ficha RUC (p. ej. "LIMA"). */
  department: z.string().min(1),
  /** Provincia, como figura en la Ficha RUC. */
  province: z.string().min(1),
  /** Distrito, como figura en la Ficha RUC. */
  district: z.string().min(1),
  /** Dirección: vía, número, etc. (hasta 200 caracteres). */
  street: z.string().min(1).max(200),
  /** Urbanización (opcional, hasta 100 caracteres). */
  urbanization: z.string().max(100).optional(),
  /** Código del establecimiento anexo; "0000" es el domicilio fiscal. */
  establishmentCode: z.string().regex(/^\d{4}$/).default('0000'),
  /** Código de país ISO 3166-1 de 2 letras. */
  countryCode: z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'El código de país tiene 2 letras, por ejemplo PE'))
    .default('PE'),
};
export const AddressSchema: z.ZodObject<typeof addressShape> = z.object(addressShape);

const issuerShape = {
  /** RUC del emisor (11 dígitos, con dígito verificador válido). */
  ruc: z.string().refine(isValidRuc, 'RUC inválido'),
  /** Razón social del emisor (hasta 200 caracteres). */
  legalName: z.string().min(1).max(200),
  /** Nombre comercial (opcional): se incluye en el XML. */
  tradeName: z.string().max(200).optional(),
  /** Domicilio fiscal, o el del establecimiento anexo que emite (ver `establishmentCode`). */
  address: AddressSchema,
  /** Correo de contacto (opcional): se incluye en el XML. */
  email: z.string().email().optional(),
  /** Teléfono de contacto (opcional, hasta 30 caracteres): se incluye en el XML. */
  phone: z.string().max(30).optional(),
};
/** Datos del contribuyente que emite (el titular del RUC). */
export const IssuerSchema: z.ZodObject<typeof issuerShape> = z.object(issuerShape);

const invoiceCustomerShape = {
  /** RUC del cliente: las facturas solo se emiten a clientes con RUC. */
  ruc: z.string().refine(isValidRuc, 'RUC del cliente inválido'),
  /** Razón social del cliente (hasta 200 caracteres). */
  name: z.string().min(1).max(200),
  /** Dirección del cliente (opcional, hasta 200 caracteres). */
  address: z.string().max(200).optional(),
};
export const InvoiceCustomerSchema: z.ZodObject<typeof invoiceCustomerShape> = z.object(invoiceCustomerShape);

const invoiceItemShape = {
  /** Descripción del bien o servicio (hasta 250 caracteres). */
  description: z.string().min(1).max(250),
  /** Cantidad: número o texto decimal (p. ej. 10 o "2.5"). */
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
};
/** Un ítem de la factura: indica `unitPrice` (con IGV) o `unitValue` (sin IGV), no ambos. */
export const InvoiceItemSchema: z.ZodObject<typeof invoiceItemShape> = z
  .object(invoiceItemShape)
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

const installmentShape = {
  /** Fecha de vencimiento `YYYY-MM-DD`: debe ser posterior a la fecha de emisión. */
  dueDate: z.string().refine(isCalendarDate, 'Debe ser una fecha válida YYYY-MM-DD'),
  /** Monto de la cuota. Indícalo en todas las cuotas o en ninguna (así se reparte en partes iguales). */
  amount: PositiveNumeric.optional(),
};
/** Una cuota del crédito. Si omites `amount` en todas, el SDK reparte el monto neto pendiente en partes iguales. */
export const InstallmentSchema: z.ZodObject<typeof installmentShape> = z.object(installmentShape);

/**
 * Forma de pago de la factura (`InvoiceInput.payment.type`). Es un objeto `as const` y a la vez un tipo con el mismo
 * nombre: `PaymentType.credit` es el valor y `PaymentType` la unión de todos.
 */
export const PaymentType = {
  /** Al contado (por defecto). */
  cash: 'cash',
  /** Al crédito, con cuotas. */
  credit: 'credit',
} as const;
export type PaymentType = (typeof PaymentType)[keyof typeof PaymentType];

const cashPaymentShape = {
  /** Al contado. */
  type: z.literal(PaymentType.cash),
};
const CashPaymentSchema: z.ZodObject<typeof cashPaymentShape> = z.object(cashPaymentShape);

const creditPaymentShape = {
  /** Al crédito. */
  type: z.literal(PaymentType.credit),
  /** Monto neto pendiente de pago. Por defecto, el total de la factura; no puede ser mayor al total. */
  netPending: PositiveNumeric.optional(),
  /** Cuotas (1 a 60). El orden no importa. */
  installments: z.array(InstallmentSchema).min(1).max(60),
};
const CreditPaymentSchema: z.ZodObject<typeof creditPaymentShape> = z.object(creditPaymentShape);

/**
 * Forma de pago (SUNAT exige indicar contado o crédito; RS 193-2020/SUNAT, anexo 9-A).
 * - `cash`: al contado (por defecto).
 * - `credit`: al crédito. El monto neto pendiente es, por defecto, el TOTAL de la factura (el caso habitual:
 *   no hace falta volver a escribirlo); si indicas otro, no puede ser mayor al total. Máximo 60 cuotas.
 */
export const InvoicePaymentSchema = z.discriminatedUnion('type', [CashPaymentSchema, CreditPaymentSchema]);

const relatedDespatchShape = {
  /** Serie de la guía, p. ej. "T001" (o "EG07" si se emitió en SOL). */
  series: z.string().transform((v) => v.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'La serie debe tener 4 caracteres')),
  /** Correlativo de la guía (1 a 99 999 999). */
  number: z.number().int().min(1).max(99_999_999),
  /** Catálogo 01: 09 = guía de remisión remitente (por defecto), 31 = guía de remisión transportista. */
  type: z.enum(['09', '31']).default('09'),
};
/** Guía de remisión relacionada con la operación que se factura. */
export const RelatedDespatchSchema: z.ZodObject<typeof relatedDespatchShape> = z.object(relatedDespatchShape);

const invoiceShape = {
  /** Serie de la factura: F + 3 caracteres, por ejemplo "F001". */
  series: z.string().regex(/^F[A-Z0-9]{3}$/, 'La serie de una factura es "F" + 3 caracteres, por ejemplo F001'),
  /** Correlativo (1 a 99 999 999). */
  number: z.number().int().min(1).max(99_999_999),
  /** Fecha y hora de emisión. Si se omite se usa la hora actual. */
  issuedAt: z.date().optional(),
  /** Moneda (`Currency`): PEN por defecto. */
  currency: z.enum(Currency).default(Currency.PEN),
  /** Catálogo 51: 0101 = venta interna. */
  operationType: z
    .string()
    .regex(/^\d{4}$/)
    .default('0101'),
  /** Cliente: las facturas solo se emiten a clientes con RUC. */
  customer: InvoiceCustomerSchema,
  /** Ítems de la factura (1 a 500). */
  items: z.array(InvoiceItemSchema).min(1).max(500),
  /** Observaciones libres que se imprimen en el comprobante. */
  note: z.string().max(500).optional(),
  /** Forma de pago. Por defecto al contado. */
  payment: InvoicePaymentSchema.default({ type: PaymentType.cash }),
  /** Número de la orden de compra del cliente (hasta 20 caracteres). */
  purchaseOrder: z.string().trim().min(1).max(20).optional(),
  /** Guías de remisión relacionadas con la operación (0 o más). */
  relatedDespatches: z.array(RelatedDespatchSchema).max(20).default([]),
};
/**
 * Schema zod de una factura. `prepareInvoice` ya lo aplica; úsalo si quieres validar un formulario antes de
 * preparar la factura (`InvoiceSchema.safeParse(datos)`).
 */
export const InvoiceSchema: z.ZodObject<typeof invoiceShape> = z.object(invoiceShape);

export type IssuerInput = z.input<typeof IssuerSchema>;
export type Issuer = z.output<typeof IssuerSchema>;
export type InvoiceInput = z.input<typeof InvoiceSchema>;
export type Invoice = z.output<typeof InvoiceSchema>;
export type InvoiceItem = z.output<typeof InvoiceItemSchema>;
export type InvoicePayment = z.output<typeof InvoicePaymentSchema>;
export type RelatedDespatch = z.output<typeof RelatedDespatchSchema>;
