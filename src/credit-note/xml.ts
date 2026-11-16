import { amountInWords } from '../amount-in-words';
import { DOCUMENT_TYPE } from '../catalogs';
import type { CalculatedInvoice } from '../invoice/calculate';
import type { Issuer } from '../invoice/schema';
import {
  amount,
  customerParty,
  documentLine,
  EMPTY_EXTENSIONS,
  signatureBlock,
  supplierParty,
  taxTotalBlock,
  ublNamespaces,
} from '../ubl-xml';
import { escapeXml as esc, limaDateTime, singleLine } from '../xml';
import type { CreditNote } from './schema';

const NAMESPACES = ublNamespaces('CreditNote-2');

/** Nombre base de los archivos: `<RUC>-07-<SERIE>-<CORRELATIVO>`. */
export function creditNoteBaseName(issuerRuc: string, note: Pick<CreditNote, 'series' | 'number'>): string {
  return `${issuerRuc}-${DOCUMENT_TYPE.creditNote}-${note.series}-${note.number}`;
}

/**
 * Genera el XML UBL 2.1 (sin firmar) de una nota de crédito sobre factura. El orden de los elementos sigue la
 * secuencia de `UBL-CreditNote-2.1.xsd`; no reordenar.
 */
export function buildCreditNoteXml(params: {
  issuer: Issuer;
  note: CreditNote;
  reasonDescription: string;
  calculation: CalculatedInvoice;
  issuedAt: Date;
}): string {
  const { issuer, note, calculation, issuedAt } = params;
  const { totals, lines } = calculation;
  const cur = note.currency;
  const { date, time } = limaDateTime(issuedAt);
  const modified = `${note.modifiedDocument.series}-${note.modifiedDocument.number}`;
  const replacement = note.replacementInvoice
    ? '<cac:AdditionalDocumentReference>' +
      `<cbc:ID>${note.replacementInvoice.series}-${note.replacementInvoice.number}</cbc:ID>` +
      '<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode></cac:AdditionalDocumentReference>'
    : '';

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<CreditNote ${NAMESPACES}>` +
    EMPTY_EXTENSIONS +
    '<cbc:UBLVersionID>2.1</cbc:UBLVersionID>' +
    '<cbc:CustomizationID>2.0</cbc:CustomizationID>' +
    `<cbc:ID>${note.series}-${note.number}</cbc:ID>` +
    `<cbc:IssueDate>${date}</cbc:IssueDate>` +
    `<cbc:IssueTime>${time}</cbc:IssueTime>` +
    `<cbc:Note languageLocaleID="1000">${esc(amountInWords(totals.payable, cur))}</cbc:Note>` +
    (note.note ? `<cbc:Note>${esc(singleLine(note.note))}</cbc:Note>` : '') +
    `<cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>` +
    '<cac:DiscrepancyResponse>' +
    `<cbc:ReferenceID>${modified}</cbc:ReferenceID>` +
    `<cbc:ResponseCode>${note.reason}</cbc:ResponseCode>` +
    `<cbc:Description>${esc(singleLine(params.reasonDescription))}</cbc:Description>` +
    '</cac:DiscrepancyResponse>' +
    '<cac:BillingReference><cac:InvoiceDocumentReference>' +
    `<cbc:ID>${modified}</cbc:ID><cbc:DocumentTypeCode>${note.modifiedDocument.type}</cbc:DocumentTypeCode>` +
    '</cac:InvoiceDocumentReference></cac:BillingReference>' +
    replacement +
    signatureBlock(issuer) +
    supplierParty(issuer) +
    customerParty(note.customer) +
    taxTotalBlock(totals, cur) +
    `<cac:LegalMonetaryTotal>${amount('PayableAmount', totals.payable, cur)}</cac:LegalMonetaryTotal>` +
    lines.map((l) => documentLine(l, cur, { line: 'CreditNoteLine', quantity: 'CreditedQuantity' })).join('') +
    '</CreditNote>'
  );
}
