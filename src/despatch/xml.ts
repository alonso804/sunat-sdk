import {
  DESPATCH_INDICATORS,
  RELATED_DOCUMENT_TYPES,
  TRANSPORT_MODE,
  TransportMode,
  type IdentityType,
} from '../catalogs';
import { dec, fmtFixed, fmtUpTo } from '../money';
import type { Issuer } from '../invoice/schema';
import { escapeXml as esc, limaDateTime, SIGNATURE_ID, singleLine } from '../xml';
import type { Despatch, DespatchItem } from './schema';

/** Tipo de comprobante de la GRE remitente (catálogo 01). */
export const DESPATCH_DOCUMENT_TYPE = '09';

const NAMESPACES = [
  'xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2"',
  'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
  'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
  'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
  'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"',
].join(' ');

const SCHEME_ATTRS = 'schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06"';

export type ResolvedParty = {
  docType: IdentityType;
  docNumber: string;
  name: string;
};

/** Nombre base de los archivos: `<RUC>-09-<SERIE>-<CORRELATIVO>`. */
export function despatchBaseName(issuerRuc: string, despatch: Pick<Despatch, 'series' | 'number'>): string {
  return `${issuerRuc}-${DESPATCH_DOCUMENT_TYPE}-${despatch.series}-${despatch.number}`;
}

function partyBlock(tag: string, party: ResolvedParty): string {
  return (
    `<cac:${tag}><cac:Party>` +
    `<cac:PartyIdentification><cbc:ID schemeID="${party.docType}" ${SCHEME_ATTRS}>${esc(party.docNumber)}</cbc:ID></cac:PartyIdentification>` +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${esc(singleLine(party.name))}</cbc:RegistrationName></cac:PartyLegalEntity>` +
    `</cac:Party></cac:${tag}>`
  );
}

function address(
  wrapper: 'DeliveryAddress' | 'DespatchAddress',
  point: Despatch['origin'],
  ownerRuc: string,
): string {
  return (
    `<cac:${wrapper}>` +
    `<cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${point.ubigeo}</cbc:ID>` +
    (point.establishmentCode ? `<cbc:AddressTypeCode listID="${ownerRuc}">${point.establishmentCode}</cbc:AddressTypeCode>` : '') +
    `<cac:AddressLine><cbc:Line>${esc(singleLine(point.address))}</cbc:Line></cac:AddressLine>` +
    `</cac:${wrapper}>`
  );
}

function despatchLine(item: DespatchItem, index: number): string {
  return (
    '<cac:DespatchLine>' +
    `<cbc:ID>${index}</cbc:ID>` +
    `<cbc:DeliveredQuantity unitCode="${item.unit}">${fmtUpTo(dec(item.quantity), 10)}</cbc:DeliveredQuantity>` +
    `<cac:OrderLineReference><cbc:LineID>${index}</cbc:LineID></cac:OrderLineReference>` +
    '<cac:Item>' +
    `<cbc:Description>${esc(singleLine(item.description))}</cbc:Description>` +
    (item.code ? `<cac:SellersItemIdentification><cbc:ID>${esc(item.code)}</cbc:ID></cac:SellersItemIdentification>` : '') +
    (item.gtin ? `<cac:StandardItemIdentification><cbc:ID>${item.gtin}</cbc:ID></cac:StandardItemIdentification>` : '') +
    (item.sunatProductCode
      ? `<cac:CommodityClassification><cbc:ItemClassificationCode listID="UNSPSC" listAgencyName="GS1 US" listName="Item Classification">${item.sunatProductCode}</cbc:ItemClassificationCode></cac:CommodityClassification>`
      : '') +
    // Igual que el XML que genera SOL: el indicador de bien regulado (catálogo 55, 7022) va siempre.
    '<cac:AdditionalItemProperty>' +
    '<cbc:Name>Indicador de bien regulado por SUNAT</cbc:Name>' +
    '<cbc:NameCode listAgencyName="PE:SUNAT" listName="Propiedad del item" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo55">7022</cbc:NameCode>' +
    `<cbc:Value>${item.regulated ? 1 : 0}</cbc:Value>` +
    '</cac:AdditionalItemProperty>' +
    '</cac:Item>' +
    '</cac:DespatchLine>'
  );
}

/**
 * Genera el XML UBL 2.1 (sin firmar) de una GRE remitente, siguiendo el estándar del anexo 14
 * de la RS 000123-2022/SUNAT. El orden de los elementos sigue la secuencia del esquema UBL.
 */
export function buildDespatchXml(params: {
  issuer: Issuer;
  despatch: Despatch;
  recipient: ResolvedParty;
  issuedAt: Date;
}): string {
  const { issuer, despatch: d, recipient, issuedAt } = params;
  const { date, time } = limaDateTime(issuedAt);
  const isPrivate = d.transportMode === TransportMode.private;
  const includeVehicleAndDrivers = isPrivate || Boolean(d.indicators.carrierVehicleAndDrivers);

  const indicators: string[] = [];
  if (d.indicators.plannedTransshipment) indicators.push(DESPATCH_INDICATORS.plannedTransshipment);
  if (d.indicators.m1lVehicle) indicators.push(DESPATCH_INDICATORS.m1lVehicle);
  if (d.indicators.carrierVehicleAndDrivers) indicators.push(DESPATCH_INDICATORS.carrierVehicleAndDrivers);

  const relatedDocuments = d.relatedDocuments
    .map(
      (doc) =>
        '<cac:AdditionalDocumentReference>' +
        `<cbc:ID>${esc(singleLine(doc.number))}</cbc:ID>` +
        '<cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Documento relacionado al transporte" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo61">' +
        `${doc.type}</cbc:DocumentTypeCode>` +
        `<cbc:DocumentType>${esc(RELATED_DOCUMENT_TYPES[doc.type])}</cbc:DocumentType>` +
        (doc.issuerRuc
          ? `<cac:IssuerParty><cac:PartyIdentification><cbc:ID schemeID="6" ${SCHEME_ATTRS}>${doc.issuerRuc}</cbc:ID></cac:PartyIdentification></cac:IssuerParty>`
          : '') +
        '</cac:AdditionalDocumentReference>',
    )
    .join('');

  const carrier = d.carrier
    ? '<cac:CarrierParty>' +
      `<cac:PartyIdentification><cbc:ID schemeID="6">${d.carrier.ruc}</cbc:ID></cac:PartyIdentification>` +
      '<cac:PartyLegalEntity>' +
      `<cbc:RegistrationName>${esc(singleLine(d.carrier.name))}</cbc:RegistrationName>` +
      (d.carrier.mtcRegistration ? `<cbc:CompanyID>${esc(d.carrier.mtcRegistration)}</cbc:CompanyID>` : '') +
      '</cac:PartyLegalEntity>' +
      '</cac:CarrierParty>'
    : '';

  const drivers = includeVehicleAndDrivers
    ? d.drivers
        .map(
          (driver) =>
            '<cac:DriverPerson>' +
            `<cbc:ID schemeID="${driver.docType}" ${SCHEME_ATTRS}>${esc(driver.docNumber)}</cbc:ID>` +
            `<cbc:FirstName>${esc(singleLine(driver.firstName))}</cbc:FirstName>` +
            `<cbc:FamilyName>${esc(singleLine(driver.lastName))}</cbc:FamilyName>` +
            `<cbc:JobTitle>${driver.kind}</cbc:JobTitle>` +
            `<cac:IdentityDocumentReference><cbc:ID>${esc(driver.license)}</cbc:ID></cac:IdentityDocumentReference>` +
            '</cac:DriverPerson>',
        )
        .join('')
    : '';

  // Transporte privado en vehículo M1/L sin placa: SOL escribe igualmente un TransportEquipment vacío.
  const vehicle =
    includeVehicleAndDrivers && d.vehicle
      ? `<cac:TransportHandlingUnit><cac:TransportEquipment><cbc:ID>${d.vehicle.plate}</cbc:ID></cac:TransportEquipment></cac:TransportHandlingUnit>`
      : isPrivate && d.indicators.m1lVehicle
        ? '<cac:TransportHandlingUnit><cac:TransportEquipment/></cac:TransportHandlingUnit>'
        : '';

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<DespatchAdvice ${NAMESPACES}>` +
    '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>' +
    '<cbc:UBLVersionID>2.1</cbc:UBLVersionID>' +
    '<cbc:CustomizationID>2.0</cbc:CustomizationID>' +
    `<cbc:ID>${d.series}-${d.number}</cbc:ID>` +
    `<cbc:IssueDate>${date}</cbc:IssueDate>` +
    `<cbc:IssueTime>${time}</cbc:IssueTime>` +
    `<cbc:DespatchAdviceTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">${DESPATCH_DOCUMENT_TYPE}</cbc:DespatchAdviceTypeCode>` +
    (d.note ? `<cbc:Note>${esc(singleLine(d.note))}</cbc:Note>` : '') +
    relatedDocuments +
    '<cac:Signature>' +
    `<cbc:ID>SIGN${issuer.ruc}</cbc:ID>` +
    `<cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${issuer.ruc}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${esc(singleLine(issuer.legalName))}</cbc:Name></cac:PartyName></cac:SignatoryParty>` +
    `<cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#${SIGNATURE_ID}</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment>` +
    '</cac:Signature>' +
    partyBlock('DespatchSupplierParty', { docType: '6', docNumber: issuer.ruc, name: issuer.legalName }) +
    partyBlock('DeliveryCustomerParty', recipient) +
    (d.buyer ? partyBlock('BuyerCustomerParty', d.buyer) : '') +
    (d.provider ? partyBlock('SellerSupplierParty', d.provider) : '') +
    '<cac:Shipment>' +
    '<cbc:ID>SUNAT_Envio</cbc:ID>' +
    `<cbc:HandlingCode listAgencyName="PE:SUNAT" listName="Motivo de traslado" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo20">${d.reason}</cbc:HandlingCode>` +
    (d.reason === '13' && d.reasonDescription ? `<cbc:HandlingInstructions>${esc(singleLine(d.reasonDescription))}</cbc:HandlingInstructions>` : '') +
    `<cbc:GrossWeightMeasure unitCode="${d.grossWeight.unit}">${fmtFixed(dec(d.grossWeight.value), 3)}</cbc:GrossWeightMeasure>` +
    (d.packages ? `<cbc:TotalTransportHandlingUnitQuantity>${d.packages}</cbc:TotalTransportHandlingUnitQuantity>` : '') +
    indicators.map((value) => `<cbc:SpecialInstructions>${value}</cbc:SpecialInstructions>`).join('') +
    '<cac:ShipmentStage>' +
    `<cbc:TransportModeCode listName="Modalidad de traslado" listAgencyName="PE:SUNAT" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo18">${TRANSPORT_MODE[d.transportMode]}</cbc:TransportModeCode>` +
    `<cac:TransitPeriod><cbc:StartDate>${d.transferStartDate}</cbc:StartDate></cac:TransitPeriod>` +
    carrier +
    drivers +
    '</cac:ShipmentStage>' +
    '<cac:Delivery>' +
    address('DeliveryAddress', d.destination, issuer.ruc) +
    `<cac:Despatch>${address('DespatchAddress', d.origin, issuer.ruc)}</cac:Despatch>` +
    '</cac:Delivery>' +
    vehicle +
    '</cac:Shipment>' +
    d.items.map((item, i) => despatchLine(item, i + 1)).join('') +
    '</DespatchAdvice>'
  );
}
