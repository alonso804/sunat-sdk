import { AFFECTATIONS, DOCUMENT_TYPE, IDENTITY_TYPE } from '../catalogs';
import { D, fmt2, fmtUpTo, type Dec } from '../money';
import { amountInWords } from '../numero-a-letras';
import { escapeXml as esc, limaDateTime, SIGNATURE_ID, singleLine } from '../xml';
import type { CalculatedInvoice, CalculatedLine } from './calculate';
import type { ResolvedPayment } from './payment';
import type { Invoice, Issuer } from './schema';

const NAMESPACES = [
  'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
  'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
  'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
  'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
  'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"',
].join(' ');

/** Forma de pago (anexo 9-A de la RS 193-2020/SUNAT): contado, o crédito con el monto neto pendiente y una línea por cuota. */
function paymentTerms(payment: ResolvedPayment, currency: string): string {
  const head = '<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID>';
  if (payment.type === 'cash') return `${head}<cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>`;
  const installments = payment.installments
    .map(
      (i) =>
        `${head}<cbc:PaymentMeansID>Cuota${String(i.number).padStart(3, '0')}</cbc:PaymentMeansID>` +
        `${amount('Amount', i.amount, currency)}<cbc:PaymentDueDate>${i.dueDate}</cbc:PaymentDueDate></cac:PaymentTerms>`,
    )
    .join('');
  return `${head}<cbc:PaymentMeansID>Credito</cbc:PaymentMeansID>${amount('Amount', payment.netPending, currency)}</cac:PaymentTerms>${installments}`;
}

/** Orden de compra y guías relacionadas, en el orden que fija el esquema UBL (antes de cac:Signature). */
function references(invoice: Invoice): string {
  const order = invoice.purchaseOrder ? `<cac:OrderReference><cbc:ID>${esc(singleLine(invoice.purchaseOrder))}</cbc:ID></cac:OrderReference>` : '';
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

function amount(tag: string, value: Dec, currency: string): string {
  return `<cbc:${tag} currencyID="${currency}">${fmt2(value)}</cbc:${tag}>`;
}

function taxSubtotal(taxable: Dec, tax: Dec, currency: string, scheme: { id: string; name: string; code: string }): string {
  return (
    '<cac:TaxSubtotal>' +
    amount('TaxableAmount', taxable, currency) +
    amount('TaxAmount', tax, currency) +
    `<cac:TaxCategory><cac:TaxScheme><cbc:ID>${scheme.id}</cbc:ID><cbc:Name>${scheme.name}</cbc:Name><cbc:TaxTypeCode>${scheme.code}</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>` +
    '</cac:TaxSubtotal>'
  );
}

function supplierParty(issuer: Issuer): string {
  const a = issuer.address;
  const contact =
    issuer.phone || issuer.email
      ? '<cac:Contact>' +
        (issuer.phone ? `<cbc:Telephone>${esc(issuer.phone)}</cbc:Telephone>` : '') +
        (issuer.email ? `<cbc:ElectronicMail>${esc(issuer.email)}</cbc:ElectronicMail>` : '') +
        '</cac:Contact>'
      : '';
  return (
    '<cac:AccountingSupplierParty><cac:Party>' +
    `<cac:PartyIdentification><cbc:ID schemeID="${IDENTITY_TYPE.ruc}">${issuer.ruc}</cbc:ID></cac:PartyIdentification>` +
    (issuer.tradeName ? `<cac:PartyName><cbc:Name>${esc(singleLine(issuer.tradeName))}</cbc:Name></cac:PartyName>` : '') +
    '<cac:PartyLegalEntity>' +
    `<cbc:RegistrationName>${esc(singleLine(issuer.legalName))}</cbc:RegistrationName>` +
    '<cac:RegistrationAddress>' +
    `<cbc:ID>${a.ubigeo}</cbc:ID>` +
    `<cbc:AddressTypeCode>${a.establishmentCode}</cbc:AddressTypeCode>` +
    (a.urbanization ? `<cbc:CitySubdivisionName>${esc(singleLine(a.urbanization))}</cbc:CitySubdivisionName>` : '') +
    `<cbc:CityName>${esc(a.province)}</cbc:CityName>` +
    `<cbc:CountrySubentity>${esc(a.department)}</cbc:CountrySubentity>` +
    `<cbc:District>${esc(a.district)}</cbc:District>` +
    `<cac:AddressLine><cbc:Line>${esc(singleLine(a.street))}</cbc:Line></cac:AddressLine>` +
    `<cac:Country><cbc:IdentificationCode>${a.countryCode}</cbc:IdentificationCode></cac:Country>` +
    '</cac:RegistrationAddress>' +
    '</cac:PartyLegalEntity>' +
    contact +
    '</cac:Party></cac:AccountingSupplierParty>'
  );
}

function customerParty(customer: Invoice['customer']): string {
  const address = customer.address
    ? '<cac:RegistrationAddress>' +
      `<cac:AddressLine><cbc:Line>${esc(singleLine(customer.address))}</cbc:Line></cac:AddressLine>` +
      '<cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country>' +
      '</cac:RegistrationAddress>'
    : '';
  return (
    '<cac:AccountingCustomerParty><cac:Party>' +
    `<cac:PartyIdentification><cbc:ID schemeID="${IDENTITY_TYPE.ruc}">${customer.ruc}</cbc:ID></cac:PartyIdentification>` +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${esc(singleLine(customer.name))}</cbc:RegistrationName>${address}</cac:PartyLegalEntity>` +
    '</cac:Party></cac:AccountingCustomerParty>'
  );
}

function invoiceLine(line: CalculatedLine, currency: string): string {
  const aff = AFFECTATIONS[line.affectation];
  const percent = fmt2(line.rate.mul(100));
  const taxable = line.lineValue;
  return (
    '<cac:InvoiceLine>' +
    `<cbc:ID>${line.index}</cbc:ID>` +
    `<cbc:InvoicedQuantity unitCode="${line.unit}">${fmtUpTo(line.quantity, 10)}</cbc:InvoicedQuantity>` +
    amount('LineExtensionAmount', line.lineValue, currency) +
    '<cac:PricingReference><cac:AlternativeConditionPrice>' +
    `<cbc:PriceAmount currencyID="${currency}">${fmtUpTo(line.unitPrice, 10)}</cbc:PriceAmount>` +
    '<cbc:PriceTypeCode>01</cbc:PriceTypeCode>' +
    '</cac:AlternativeConditionPrice></cac:PricingReference>' +
    '<cac:TaxTotal>' +
    amount('TaxAmount', line.igv, currency) +
    '<cac:TaxSubtotal>' +
    amount('TaxableAmount', taxable, currency) +
    amount('TaxAmount', line.igv, currency) +
    '<cac:TaxCategory>' +
    `<cbc:Percent>${percent}</cbc:Percent>` +
    `<cbc:TaxExemptionReasonCode>${line.affectation}</cbc:TaxExemptionReasonCode>` +
    `<cac:TaxScheme><cbc:ID>${aff.scheme.id}</cbc:ID><cbc:Name>${aff.scheme.name}</cbc:Name><cbc:TaxTypeCode>${aff.scheme.code}</cbc:TaxTypeCode></cac:TaxScheme>` +
    '</cac:TaxCategory>' +
    '</cac:TaxSubtotal>' +
    '</cac:TaxTotal>' +
    '<cac:Item>' +
    `<cbc:Description>${esc(singleLine(line.description))}</cbc:Description>` +
    (line.productCode ? `<cac:SellersItemIdentification><cbc:ID>${esc(line.productCode)}</cbc:ID></cac:SellersItemIdentification>` : '') +
    '</cac:Item>' +
    `<cac:Price><cbc:PriceAmount currencyID="${currency}">${fmtUpTo(line.unitValue, 10)}</cbc:PriceAmount></cac:Price>` +
    '</cac:InvoiceLine>'
  );
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
  issuedAt: Date;
}): string {
  const { issuer, invoice, calculation, payment, issuedAt } = params;
  const { totals, lines } = calculation;
  const cur = invoice.currency;
  const { date, time } = limaDateTime(issuedAt);

  const zero = new D(0);
  const taxSubtotals =
    (totals.hasTaxed ? taxSubtotal(totals.taxedBase, totals.igv, cur, AFFECTATIONS['10'].scheme) : '') +
    (totals.hasUnaffected ? taxSubtotal(totals.unaffectedBase, zero, cur, AFFECTATIONS['30'].scheme) : '') +
    (totals.hasExonerated ? taxSubtotal(totals.exoneratedBase, zero, cur, AFFECTATIONS['20'].scheme) : '');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Invoice ${NAMESPACES}>` +
    '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>' +
    '<cbc:UBLVersionID>2.1</cbc:UBLVersionID>' +
    '<cbc:CustomizationID>2.0</cbc:CustomizationID>' +
    `<cbc:ID>${invoice.series}-${invoice.number}</cbc:ID>` +
    `<cbc:IssueDate>${date}</cbc:IssueDate>` +
    `<cbc:IssueTime>${time}</cbc:IssueTime>` +
    `<cbc:InvoiceTypeCode listID="${invoice.operationType}">${DOCUMENT_TYPE.invoice}</cbc:InvoiceTypeCode>` +
    `<cbc:Note languageLocaleID="1000">${esc(amountInWords(totals.payable, cur))}</cbc:Note>` +
    (invoice.note ? `<cbc:Note>${esc(singleLine(invoice.note))}</cbc:Note>` : '') +
    `<cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>` +
    references(invoice) +
    '<cac:Signature>' +
    `<cbc:ID>SIGN${issuer.ruc}</cbc:ID>` +
    `<cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${issuer.ruc}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${esc(singleLine(issuer.legalName))}</cbc:Name></cac:PartyName></cac:SignatoryParty>` +
    `<cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#${SIGNATURE_ID}</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment>` +
    '</cac:Signature>' +
    supplierParty(issuer) +
    customerParty(invoice.customer) +
    paymentTerms(payment, cur) +
    '<cac:TaxTotal>' +
    amount('TaxAmount', totals.igv, cur) +
    taxSubtotals +
    '</cac:TaxTotal>' +
    '<cac:LegalMonetaryTotal>' +
    amount('LineExtensionAmount', totals.lineExtension, cur) +
    amount('TaxInclusiveAmount', totals.taxInclusive, cur) +
    amount('PayableAmount', totals.payable, cur) +
    '</cac:LegalMonetaryTotal>' +
    lines.map((l) => invoiceLine(l, cur)).join('') +
    '</Invoice>'
  );
}
