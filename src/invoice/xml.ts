import { amountInWords } from '../amount-in-words';
import { DETRACTION, DOCUMENT_TYPE } from '../catalogs';
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
import type { CalculatedInvoice } from './calculate';
import type { ResolvedDetraction } from './detraction';
import type { ResolvedPayment } from './payment';
import { type Invoice, type Issuer, PaymentType } from './schema';

const NAMESPACES = ublNamespaces('Invoice-2');

/** Forma de pago (anexo 9-A de la RS 193-2020/SUNAT): contado, o crédito con el monto neto pendiente y una línea por cuota. */
function paymentTerms(payment: ResolvedPayment, currency: string): string {
  const head = '<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID>';
  if (payment.type === PaymentType.cash)
    return `${head}<cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>`;
  const installments = payment.installments
    .map(
      (i) =>
        `${head}<cbc:PaymentMeansID>Cuota${String(i.number).padStart(3, '0')}</cbc:PaymentMeansID>` +
        `${amount('Amount', i.amount, currency)}<cbc:PaymentDueDate>${i.dueDate}</cbc:PaymentDueDate></cac:PaymentTerms>`,
    )
    .join('');
  return `${head}<cbc:PaymentMeansID>Credito</cbc:PaymentMeansID>${amount('Amount', payment.netPending, currency)}</cac:PaymentTerms>${installments}`;
}

/** Detracción: cuenta y medio de pago (`cac:PaymentMeans`) y código del servicio, porcentaje y monto en soles. */
function detractionBlocks(detraction: ResolvedDetraction | undefined): { means: string; terms: string } {
  if (!detraction) return { means: '', terms: '' };
  return {
    means:
      '<cac:PaymentMeans><cbc:ID>Detraccion</cbc:ID>' +
      `<cbc:PaymentMeansCode>${DETRACTION.paymentMeansCode}</cbc:PaymentMeansCode>` +
      `<cac:PayeeFinancialAccount><cbc:ID>${detraction.account}</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>`,
    terms:
      '<cac:PaymentTerms><cbc:ID>Detraccion</cbc:ID>' +
      `<cbc:PaymentMeansID>${DETRACTION.goodsServiceCode}</cbc:PaymentMeansID>` +
      `<cbc:PaymentPercent>${DETRACTION.percent}</cbc:PaymentPercent>` +
      `${amount('Amount', detraction.amount, 'PEN')}</cac:PaymentTerms>`,
  };
}

/** Orden de compra y guías relacionadas, en el orden que fija el esquema UBL (antes de cac:Signature). */
function references(invoice: Invoice): string {
  const order = invoice.purchaseOrder
    ? `<cac:OrderReference><cbc:ID>${esc(singleLine(invoice.purchaseOrder))}</cbc:ID></cac:OrderReference>`
    : '';
  const despatches = invoice.relatedDespatches
    .map(
      (d) =>
        `<cac:DespatchDocumentReference><cbc:ID>${d.series}-${d.number}</cbc:ID>` +
        '<cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" ' +
        `listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">${d.type}</cbc:DocumentTypeCode></cac:DespatchDocumentReference>`,
    )
    .join('');
  return order + despatches;
}

/** Nombre base de los archivos: `<RUC>-01-<SERIE>-<CORRELATIVO>`. */
export function invoiceBaseName(issuerRuc: string, invoice: Pick<Invoice, 'series' | 'number'>): string {
  return `${issuerRuc}-${DOCUMENT_TYPE.invoice}-${invoice.series}-${invoice.number}`;
}

/**
 * Genera el XML UBL 2.1 (sin firmar) de una factura al contado.
 * El orden de los elementos sigue la secuencia del esquema UBL; no reordenar.
 */
export function buildInvoiceXml(params: {
  issuer: Issuer;
  invoice: Invoice;
  calculation: CalculatedInvoice;
  payment: ResolvedPayment;
  /** Detracción ya resuelta (ver `resolveDetraction`); fuerza el tipo de operación 1001. */
  detraction?: ResolvedDetraction | undefined;
  issuedAt: Date;
}): string {
  const { issuer, invoice, calculation, payment, detraction, issuedAt } = params;
  const { totals, lines } = calculation;
  const cur = invoice.currency;
  const { date, time } = limaDateTime(issuedAt);
  const operationType = detraction ? DETRACTION.operationType : invoice.operationType;
  const detractionXml = detractionBlocks(detraction);

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Invoice ${NAMESPACES}>` +
    EMPTY_EXTENSIONS +
    '<cbc:UBLVersionID>2.1</cbc:UBLVersionID>' +
    '<cbc:CustomizationID>2.0</cbc:CustomizationID>' +
    `<cbc:ID>${invoice.series}-${invoice.number}</cbc:ID>` +
    `<cbc:IssueDate>${date}</cbc:IssueDate>` +
    `<cbc:IssueTime>${time}</cbc:IssueTime>` +
    `<cbc:InvoiceTypeCode listID="${operationType}">${DOCUMENT_TYPE.invoice}</cbc:InvoiceTypeCode>` +
    `<cbc:Note languageLocaleID="1000">${esc(amountInWords(totals.payable, cur))}</cbc:Note>` +
    (detraction
      ? `<cbc:Note languageLocaleID="${DETRACTION.legendCode}">${esc(DETRACTION.legendText)}</cbc:Note>`
      : '') +
    (invoice.note ? `<cbc:Note>${esc(singleLine(invoice.note))}</cbc:Note>` : '') +
    `<cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>` +
    references(invoice) +
    signatureBlock(issuer) +
    supplierParty(issuer) +
    customerParty(invoice.customer) +
    detractionXml.means +
    detractionXml.terms +
    paymentTerms(payment, cur) +
    taxTotalBlock(totals, cur) +
    '<cac:LegalMonetaryTotal>' +
    amount('LineExtensionAmount', totals.lineExtension, cur) +
    amount('TaxInclusiveAmount', totals.taxInclusive, cur) +
    amount('PayableAmount', totals.payable, cur) +
    '</cac:LegalMonetaryTotal>' +
    lines.map((l) => documentLine(l, cur, { line: 'InvoiceLine', quantity: 'InvoicedQuantity' })).join('') +
    '</Invoice>'
  );
}
