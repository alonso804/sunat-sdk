import { AFFECTATIONS, IDENTITY_TYPE } from './catalogs';
import type { CalculatedLine, CalculatedTotals } from './invoice/calculate';
import type { Issuer } from './invoice/schema';
import { D, type Dec, fmt2, fmtUpTo } from './money';
import { escapeXml as esc, SIGNATURE_ID, singleLine } from './xml';

/** Espacios de nombres de un documento UBL 2.1 de SUNAT; `rootNamespace` es el del documento (Invoice-2, CreditNote-2…). */
export function ublNamespaces(rootNamespace: string): string {
  return [
    `xmlns="urn:oasis:names:specification:ubl:schema:xsd:${rootNamespace}"`,
    'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
    'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"',
  ].join(' ');
}

export function amount(tag: string, value: Dec, currency: string): string {
  return `<cbc:${tag} currencyID="${currency}">${fmt2(value)}</cbc:${tag}>`;
}

function taxSubtotal(
  taxable: Dec,
  tax: Dec,
  currency: string,
  scheme: { id: string; name: string; code: string },
): string {
  return (
    '<cac:TaxSubtotal>' +
    amount('TaxableAmount', taxable, currency) +
    amount('TaxAmount', tax, currency) +
    `<cac:TaxCategory><cac:TaxScheme><cbc:ID>${scheme.id}</cbc:ID><cbc:Name>${scheme.name}</cbc:Name><cbc:TaxTypeCode>${scheme.code}</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>` +
    '</cac:TaxSubtotal>'
  );
}

/** `ext:UBLExtensions` vacío donde se coloca la firma. */
export const EMPTY_EXTENSIONS =
  '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>';

/** `cac:Signature`: identifica al firmante y apunta a la firma de `ext:UBLExtensions`. */
export function signatureBlock(issuer: Issuer): string {
  return (
    '<cac:Signature>' +
    `<cbc:ID>SIGN${issuer.ruc}</cbc:ID>` +
    `<cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${issuer.ruc}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${esc(singleLine(issuer.legalName))}</cbc:Name></cac:PartyName></cac:SignatoryParty>` +
    `<cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#${SIGNATURE_ID}</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment>` +
    '</cac:Signature>'
  );
}

export function supplierParty(issuer: Issuer): string {
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
    (issuer.tradeName
      ? `<cac:PartyName><cbc:Name>${esc(singleLine(issuer.tradeName))}</cbc:Name></cac:PartyName>`
      : '') +
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
    `<cac:Country><cbc:IdentificationCode>${esc(a.countryCode)}</cbc:IdentificationCode></cac:Country>` +
    '</cac:RegistrationAddress>' +
    '</cac:PartyLegalEntity>' +
    contact +
    '</cac:Party></cac:AccountingSupplierParty>'
  );
}

export function customerParty(customer: { ruc: string; name: string; address?: string | undefined }): string {
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

/** `cac:TaxTotal` del documento: IGV, inafecto y exonerado según las líneas. */
export function taxTotalBlock(totals: CalculatedTotals, currency: string): string {
  const zero = new D(0);
  return (
    '<cac:TaxTotal>' +
    amount('TaxAmount', totals.igv, currency) +
    (totals.hasTaxed ? taxSubtotal(totals.taxedBase, totals.igv, currency, AFFECTATIONS['10'].scheme) : '') +
    (totals.hasUnaffected ? taxSubtotal(totals.unaffectedBase, zero, currency, AFFECTATIONS['30'].scheme) : '') +
    (totals.hasExonerated ? taxSubtotal(totals.exoneratedBase, zero, currency, AFFECTATIONS['20'].scheme) : '') +
    '</cac:TaxTotal>'
  );
}

/** Línea de factura (`InvoiceLine`/`InvoicedQuantity`) o de nota de crédito (`CreditNoteLine`/`CreditedQuantity`). */
export function documentLine(
  line: CalculatedLine,
  currency: string,
  tags: { line: 'InvoiceLine' | 'CreditNoteLine'; quantity: 'InvoicedQuantity' | 'CreditedQuantity' },
): string {
  const aff = AFFECTATIONS[line.affectation];
  const percent = fmt2(line.rate.mul(100));
  const taxable = line.lineValue;
  return (
    `<cac:${tags.line}>` +
    `<cbc:ID>${line.index}</cbc:ID>` +
    `<cbc:${tags.quantity} unitCode="${line.unit}">${fmtUpTo(line.quantity, 10)}</cbc:${tags.quantity}>` +
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
    (line.productCode
      ? `<cac:SellersItemIdentification><cbc:ID>${esc(line.productCode)}</cbc:ID></cac:SellersItemIdentification>`
      : '') +
    '</cac:Item>' +
    `<cac:Price><cbc:PriceAmount currencyID="${currency}">${fmtUpTo(line.unitValue, 10)}</cbc:PriceAmount></cac:Price>` +
    `</cac:${tags.line}>`
  );
}
