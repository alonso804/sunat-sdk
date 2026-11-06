import { XMLParser } from 'fast-xml-parser';
import { SunatError } from './errors';
import type { Untyped } from './untyped';
import { unzipFiles } from './zip';

/** Constancia de Recepción (CDR) que SUNAT devuelve al procesar un comprobante. */
export type Cdr = {
  /** Serie-correlativo del comprobante, por ejemplo "F001-1". */
  referenceId: string;
  /** "0" = aceptado. Cualquier otro valor indica rechazo. */
  responseCode: string;
  /** Mensaje de SUNAT, p. ej. "La Factura numero F001-1, ha sido aceptada". */
  description: string;
  /** Observaciones (códigos 4000+): el comprobante se aceptó pero conviene corregirlas. */
  notes: string[];
  /** `true` si `responseCode` es "0" (con o sin observaciones). */
  accepted: boolean;
  /**
   * Solo en guías de remisión (GRE): URL que SUNAT entrega en el CDR para el código QR. Es EXACTAMENTE el
   * texto que debe codificar el QR (RS 000123-2022/SUNAT: el QR se genera "a partir de la información
   * proporcionada por la SUNAT en el CDR"). Al abrirla, SUNAT descarga el PDF oficial de la guía.
   */
  qrUrl?: string;
};

/** Acepta solo URLs `https` de un dominio `*.sunat.gob.pe`: el SDK las descarga y no debe seguir otras. */
export function isSunatHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'sunat.gob.pe' || url.hostname.endsWith('.sunat.gob.pe'));
  } catch {
    return false;
  }
}

const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => name === 'Note',
});

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['#text']);
  }
  return String(value);
}

export function parseCdrXml(xml: string): Cdr {
  const parsed = parser.parse(xml) as Untyped;
  const root = parsed.ApplicationResponse;
  const response = root?.DocumentResponse?.Response;
  if (!root || !response) throw new SunatError('El CDR de SUNAT no tiene el formato esperado.');

  const responseCode = text(response.ResponseCode);
  const documentReference = root.DocumentResponse?.DocumentReference;
  const reference = Array.isArray(documentReference) ? documentReference[0] : documentReference;
  const qrCandidate = text(reference?.DocumentDescription).trim();
  return {
    referenceId: text(response.ReferenceID),
    responseCode,
    description: text(response.Description),
    notes: ((root.Note as unknown[] | undefined) ?? []).map(text).filter(Boolean),
    accepted: responseCode === '0',
    ...(isSunatHttpsUrl(qrCandidate) ? { qrUrl: qrCandidate } : {}),
  };
}

/** Decodifica el `applicationResponse` (ZIP en base64) del servicio y lee el CDR que contiene. */
export function readCdrFromApplicationResponse(applicationResponseBase64: string): {
  cdr: Cdr;
  cdrZip: Uint8Array;
  cdrXml: string;
} {
  const cdrZip = new Uint8Array(Buffer.from(applicationResponseBase64, 'base64'));
  const files = unzipFiles(cdrZip);
  const xmlName = Object.keys(files).find((name) => name.toLowerCase().endsWith('.xml'));
  const xmlBytes = xmlName ? files[xmlName] : undefined;
  if (!xmlBytes) throw new SunatError('La respuesta de SUNAT no contiene un CDR (.xml).');
  const cdrXml = Buffer.from(xmlBytes).toString('utf8');
  return { cdr: parseCdrXml(cdrXml), cdrZip, cdrXml };
}
