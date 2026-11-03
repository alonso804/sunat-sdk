/** Tasa del IGV vigente (16% + 2% IPM). */
export const IGV_RATE = '0.18';

/** Catálogo 07 de SUNAT: tipo de afectación del IGV. Por ahora solo se soportan los de uso común. */
export type IgvAffectation = '10' | '20' | '30';

export type TaxScheme = {
  id: string;
  name: string;
  code: string;
};

export const AFFECTATIONS: Record<IgvAffectation, { scheme: TaxScheme; taxed: boolean }> = {
  /** Gravado - operación onerosa */
  '10': { scheme: { id: '1000', name: 'IGV', code: 'VAT' }, taxed: true },
  /** Exonerado - operación onerosa */
  '20': { scheme: { id: '9997', name: 'EXO', code: 'VAT' }, taxed: false },
  /** Inafecto - operación onerosa */
  '30': { scheme: { id: '9998', name: 'INA', code: 'FRE' }, taxed: false },
};

/** Catálogo 01: tipos de comprobante. */
export const DOCUMENT_TYPE = {
  invoice: '01',
  receipt: '03',
  creditNote: '07',
  debitNote: '08',
} as const;

/** Catálogo 06: tipo de documento de identidad. */
export const IDENTITY_TYPE = {
  ruc: '6',
  dni: '1',
} as const;

/** Catálogo 06 (subconjunto para guías): el valor es la descripción de SUNAT. */
export const IDENTITY_TYPES = {
  '0': 'Doc. trib. no domiciliado sin RUC',
  '1': 'DNI',
  '4': 'Carné de extranjería',
  '6': 'RUC',
  '7': 'Pasaporte',
  A: 'Cédula diplomática de identidad',
} as const;
export type IdentityType = keyof typeof IDENTITY_TYPES;

/**
 * Catálogo 20: motivo de traslado (RS 000123-2022/SUNAT, anexo 8).
 * Se soportan los que no requieren datos aduaneros; 08 (importación), 09 (exportación)
 * y 18 (emisor itinerante) quedan fuera por ahora.
 */
export const TRANSFER_REASONS = {
  '01': 'Venta',
  '02': 'Compra',
  '03': 'Venta con entrega a terceros',
  '04': 'Traslado entre establecimientos de la misma empresa',
  '05': 'Consignación',
  '06': 'Devolución',
  '07': 'Recojo de bienes transformados',
  '13': 'Otros',
  '14': 'Venta sujeta a confirmación del comprador',
  '17': 'Traslado de bienes para transformación',
} as const;
export type TransferReason = keyof typeof TRANSFER_REASONS;

/** Motivos en los que el destinatario debe ser el propio remitente (anexo 12, campo 8). */
export const SELF_RECIPIENT_REASONS: readonly TransferReason[] = ['02', '04', '07'];

/** Catálogo 18: modalidad de traslado. */
export const TRANSPORT_MODE = {
  public: '01',
  private: '02',
} as const;

/** Catálogo 61: documentos relacionados aplicables a las GRE (subconjunto). */
export const RELATED_DOCUMENT_TYPES = {
  '01': 'Factura',
  '03': 'Boleta de venta',
  '04': 'Liquidación de compra',
  '09': 'Guía de remisión remitente',
  '12': 'Ticket o cinta de máquina registradora',
  '31': 'Guía de remisión transportista',
  '49': 'Constancia de depósito - IVAP',
  '80': 'Constancia de depósito - Detracción',
  '81': 'Código de autorización SCOP',
  '82': 'Declaración jurada de mudanza',
} as const;
export type RelatedDocumentType = keyof typeof RELATED_DOCUMENT_TYPES;

/** Valores fijos que SUNAT define para los indicadores de la GRE (`cbc:SpecialInstructions`). */
export const DESPATCH_INDICATORS = {
  plannedTransshipment: 'SUNAT_Envio_IndicadorTransbordoProgramado',
  m1lVehicle: 'SUNAT_Envio_IndicadorTrasladoVehiculoM1L',
  emptyContainerReturn: 'SUNAT_Envio_IndicadorRetornoVehiculoEnvaseVacio',
  emptyVehicleReturn: 'SUNAT_Envio_IndicadorRetornoVehiculoVacio',
  carrierVehicleAndDrivers: 'SUNAT_Envio_IndicadorVehiculoConductoresTransp',
} as const;
