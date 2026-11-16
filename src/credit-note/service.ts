import { amountInWords } from '../amount-in-words';
import { CREDIT_NOTE_REASONS, type CreditNoteReason, type Currency } from '../catalogs';
import { calculateInvoice } from '../invoice/calculate';
import type { Issuer } from '../invoice/schema';
import { fmt2, fmtUpTo } from '../money';
import type { SigningKey } from '../signing/certificate';
import { extractDigestValue, type SignatureAlgorithm, signUblXml } from '../signing/xmldsig';
import { TextCharset, toLatin1Deep } from '../text-charset';
import { toValidationError } from '../validation';
import { limaDateTime } from '../xml';
import { type CreditNoteInput, CreditNoteSchema } from './schema';
import { buildCreditNoteXml, creditNoteBaseName } from './xml';

/** Resumen legible para mostrar al usuario y pedir confirmación antes de emitir la nota. */
export type CreditNoteSummary = {
  series: string;
  number: number;
  currency: Currency;
  customer: { ruc: string; name: string };
  /** Comprobante que modifica, como `SERIE-NÚMERO`. */
  modifiedDocument: { type: '01'; number: string };
  /** Motivo (catálogo 09) con su nombre y el sustento que irá en el XML. */
  reason: { code: CreditNoteReason; label: string; description: string };
  /** Líneas como texto: cantidad, precio unitario con IGV (hasta 10 decimales), valor de la línea sin IGV e IGV. */
  lines: Array<{ description: string; quantity: string; unitPrice: string; lineValue: string; igv: string }>;
  taxedBase: string;
  exoneratedBase: string;
  unaffectedBase: string;
  igv: string;
  /** Importe total de la nota. */
  total: string;
  /** Total en letras, p. ej. "SON: CIENTO DIECIOCHO CON 00/100 SOLES". */
  totalInWords: string;
  /** Factura correcta ya emitida (solo motivo 02), como `SERIE-NÚMERO`. */
  replacementInvoice?: string;
};

/** Nota de crédito validada, calculada y firmada, lista para enviarse. No tiene efecto hasta que se envía. */
export type PreparedCreditNote = {
  /** `<RUC>-07-<SERIE>-<CORRELATIVO>`: nombre de los archivos XML y ZIP. */
  baseName: string;
  /** XML UBL 2.1 firmado, tal como se enviará. Guárdalo junto al CDR. */
  signedXml: string;
  /** Hash (DigestValue) del documento firmado. */
  digestValue: string | undefined;
  /** Fecha y hora de emisión que lleva el XML. */
  issuedAt: Date;
  /** Resumen para confirmar con el usuario antes de `sendCreditNote`. */
  summary: CreditNoteSummary;
  /** Avisos para el usuario antes de confirmar el envío. */
  warnings: string[];
};

export function prepareCreditNote(params: {
  issuer: Issuer;
  input: CreditNoteInput;
  signingKey: SigningKey;
  algorithm: SignatureAlgorithm;
  now: () => Date;
  textCharset?: TextCharset;
}): PreparedCreditNote {
  const parsed = CreditNoteSchema.safeParse(params.input);
  if (!parsed.success) throw toValidationError(parsed.error);
  const note = params.textCharset === TextCharset.latin1 ? toLatin1Deep(parsed.data) : parsed.data;

  const issuedAt = note.issuedAt ?? params.now();
  const calculation = calculateInvoice(note);
  const description = note.reasonDescription ?? CREDIT_NOTE_REASONS[note.reason];
  const unsignedXml = buildCreditNoteXml({
    issuer: params.issuer,
    note,
    reasonDescription: description,
    calculation,
    issuedAt,
  });
  const signedXml = signUblXml(unsignedXml, params.signingKey, params.algorithm);
  const { totals } = calculation;

  const warnings = [
    `Envíala a SUNAT el ${limaDateTime(issuedAt).date} o, a más tardar, el día calendario siguiente (RS 193-2020/SUNAT, art. 3.1).`,
    'Si SUNAT la rechaza (códigos 2000–3999), el correlativo queda consumido: corrige y emite con el siguiente número.',
  ];
  if (note.reason === '02' || note.reason === '03') {
    warnings.push(
      'Con los motivos 02 y 03 la nota se emite hasta el décimo día hábil del mes siguiente al de la factura (guía XML de la nota de crédito, SUNAT).',
    );
  }

  return {
    baseName: creditNoteBaseName(params.issuer.ruc, note),
    signedXml,
    digestValue: extractDigestValue(signedXml),
    issuedAt,
    warnings,
    summary: {
      series: note.series,
      number: note.number,
      currency: note.currency,
      customer: { ruc: note.customer.ruc, name: note.customer.name },
      modifiedDocument: {
        type: note.modifiedDocument.type,
        number: `${note.modifiedDocument.series}-${note.modifiedDocument.number}`,
      },
      reason: { code: note.reason, label: CREDIT_NOTE_REASONS[note.reason], description },
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
      totalInWords: amountInWords(totals.payable, note.currency),
      ...(note.replacementInvoice
        ? { replacementInvoice: `${note.replacementInvoice.series}-${note.replacementInvoice.number}` }
        : {}),
    },
  };
}
