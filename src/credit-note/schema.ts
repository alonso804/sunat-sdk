import { z } from 'zod';
import { CREDIT_NOTE_REASONS, type CreditNoteReason, Currency } from '../catalogs';
import { InvoiceCustomerSchema, InvoiceItemSchema } from '../invoice/schema';

const upperSeries = z.string().transform((v) => v.trim().toUpperCase());

const modifiedDocumentShape = {
  /** Serie del comprobante que se modifica: 4 caracteres alfanuméricos (p. ej. "F001", o "E001" si se emitió en SOL). */
  series: upperSeries.pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'La serie debe tener 4 caracteres')),
  /** Correlativo del comprobante que se modifica (1 a 99 999 999). */
  number: z.number().int().min(1).max(99_999_999),
  /** Catálogo 01: por ahora solo facturas (`01`). */
  type: z.literal('01').default('01'),
};
/** Comprobante que modifica la nota de crédito. */
export const ModifiedDocumentSchema: z.ZodObject<typeof modifiedDocumentShape> = z.object(modifiedDocumentShape);

const creditNoteShape = {
  /** Serie de la nota de crédito: "F" + 3 caracteres cuando modifica una factura, por ejemplo "FC01". */
  series: upperSeries.pipe(
    z
      .string()
      .regex(/^F[A-Z0-9]{3}$/, 'La serie de una nota de crédito sobre factura es "F" + 3 caracteres, p. ej. FC01'),
  ),
  /** Correlativo (1 a 99 999 999), independiente del de las notas impresas. */
  number: z.number().int().min(1).max(99_999_999),
  /** Fecha y hora de emisión. Si se omite se usa la hora actual. */
  issuedAt: z.date().optional(),
  /** Moneda (`Currency`): debe ser la del comprobante que se modifica. PEN por defecto. */
  currency: z.enum(Currency).default(Currency.PEN),
  /** Comprobante que se modifica. */
  modifiedDocument: ModifiedDocumentSchema,
  /** Catálogo 09 (`CREDIT_NOTE_REASONS`): 01 a 10. El 13 (cuotas del crédito) aún no está soportado. */
  reason: z.string().superRefine((value, ctx) => {
    if (value in CREDIT_NOTE_REASONS) return;
    ctx.addIssue({
      code: 'custom',
      message:
        value === '13'
          ? 'El motivo 13 (corregir cuotas del crédito) aún no está soportado'
          : 'Debe ser un código 01 a 10 del catálogo 09',
    });
  }) as unknown as z.ZodType<CreditNoteReason>,
  /** Sustento o motivo (hasta 250 caracteres). Por defecto, el nombre del motivo del catálogo. */
  reasonDescription: z.string().trim().min(1).max(250).optional(),
  /** Cliente: el mismo de la factura que se modifica. */
  customer: InvoiceCustomerSchema,
  /** Líneas de la nota (1 a 500): bienes devueltos (servicios: cantidad 1) o importe del ajuste, con los mismos campos de la factura. */
  items: z.array(InvoiceItemSchema).min(1).max(500),
  /** Observaciones libres que se imprimen en el comprobante. */
  note: z.string().max(500).optional(),
  /** Solo motivo 02: la factura correcta que ya se emitió al verdadero cliente. */
  replacementInvoice: z
    .object({
      series: upperSeries.pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'La serie debe tener 4 caracteres')),
      number: z.number().int().min(1).max(99_999_999),
    })
    .optional(),
};
/**
 * Schema zod de una nota de crédito sobre factura. `prepareCreditNote` ya lo aplica; úsalo para validar un formulario.
 */
export const CreditNoteSchema = z.object(creditNoteShape).superRefine((note, ctx) => {
  if (note.replacementInvoice && note.reason !== '02') {
    ctx.addIssue({
      code: 'custom',
      path: ['replacementInvoice'],
      message: 'Solo se indica con el motivo 02 (anulación por error en el RUC)',
    });
  }
});

/** Nota de crédito tal como la pasas a `prepareCreditNote`. */
export type CreditNoteInput = z.input<typeof CreditNoteSchema>;
/** Nota de crédito ya validada, con los valores por defecto aplicados. */
export type CreditNote = z.output<typeof CreditNoteSchema>;
