export type Environment = 'beta' | 'homologation' | 'production';

export type EnvironmentEndpoints = {
  /** SOAP billService: sendBill / getStatus / sendSummary (facturas, boletas, notas). */
  billService: string;
  /**
   * SOAP billConsultService: `getStatusCdr` (estado y CDR de una factura o nota). El manual del programador
   * solo lo publica para producción; en beta no hay servicio de consulta.
   */
  consultService?: string;
};

/**
 * Endpoints de SUNAT para facturas, boletas y notas (SOAP).
 *
 * - beta: solo valida la estructura del XML (usuario `<RUC>MODDATOS`, clave `MODDATOS`, sin certificado registrado).
 * - homologation: ambiente del proceso de homologación (a confirmar con SUNAT al iniciar el trámite).
 * - production: ambiente real, cada comprobante aceptado tiene efecto tributario.
 */
export const ENDPOINTS: Record<Environment, EnvironmentEndpoints> = {
  beta: {
    billService: 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService',
  },
  homologation: {
    billService: 'https://www.sunat.gob.pe/ol-ti-itcpgem-sqa/billService',
  },
  production: {
    billService: 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService',
    consultService: 'https://e-factura.sunat.gob.pe/ol-it-wsconscpegem/billConsultService',
  },
};

/** Zona horaria oficial para las fechas de emisión (Perú no usa horario de verano). */
export const SUNAT_TIME_ZONE = 'America/Lima';
