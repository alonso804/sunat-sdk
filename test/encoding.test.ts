import { describe, expect, it } from 'vitest';
import { SunatClient } from '../src';
import { verifyUblSignature } from '../src/signing/xmldsig';
import { unzipFiles, zipSingleFile } from '../src/zip';
import { hasXmllint, sampleDespatch, sampleInvoice, TEST_ISSUER, testCertificate, validateAgainstUbl } from './helpers';

const { key } = testCertificate();
const client = new SunatClient({
  environment: 'beta',
  issuer: TEST_ISSUER,
  sol: { user: 'MODDATOS', password: 'MODDATOS' },
  signingKey: key,
  now: () => new Date('2026-10-31T15:30:00-05:00'),
});

const ACCENTS = 'Cañería de PVC ½" ÁÉÍÓÚ áéíóú Ññ Üü ° – "comillas" & Cía.';

/** Lo que SUNAT recibe es el ZIP: se comprueba que los caracteres y la firma sobreviven al viaje. */
function roundTrip(name: string, xml: string): string {
  const files = unzipFiles(zipSingleFile(`${name}.xml`, xml));
  return Buffer.from(files[`${name}.xml`] as Uint8Array).toString('utf8');
}

describe('tildes y caracteres especiales (UTF-8)', () => {
  it('la factura conserva los caracteres y la firma tras comprimir y descomprimir', () => {
    const prepared = client.prepareInvoice(
      sampleInvoice({
        customer: { ruc: '20131312955', name: 'Peñasco Ñandú S.A.C.' },
        items: [{ description: ACCENTS, quantity: 1, unitPrice: 11.8 }],
      }),
    );
    const received = roundTrip(prepared.baseName, prepared.signedXml);
    expect(received).toBe(prepared.signedXml);
    expect(received).toContain('encoding="UTF-8"');
    expect(received).toContain('Cañería de PVC ½&quot; ÁÉÍÓÚ'.replace('&quot;', '"'));
    expect(received).toContain('Peñasco Ñandú S.A.C.');
    expect(verifyUblSignature(received, key.certificatePem)).toBe(true);
  });

  it('la guía conserva los caracteres y la firma, y la observación también', () => {
    const prepared = client.prepareDespatch(
      sampleDespatch({ note: 'OC 4500123456 – entrega en Peñuelas', items: [{ description: ACCENTS, quantity: 2 }] }),
    );
    const received = roundTrip(prepared.baseName, prepared.signedXml);
    expect(received).toBe(prepared.signedXml);
    expect(received).toContain('OC 4500123456 – entrega en Peñuelas');
    expect(received).toContain('ÁÉÍÓÚ áéíóú Ññ Üü °');
    expect(verifyUblSignature(received, key.certificatePem)).toBe(true);
  });

  it.skipIf(!hasXmllint)('el XML con tildes es válido contra el esquema UBL', () => {
    expect(
      validateAgainstUbl(
        client.prepareDespatch(sampleDespatch({ items: [{ description: ACCENTS, quantity: 1 }] })).signedXml,
        'DespatchAdvice',
      ).errors,
    ).toBe('- validates');
    expect(
      validateAgainstUbl(
        client.prepareInvoice(sampleInvoice({ items: [{ description: ACCENTS, quantity: 1, unitPrice: 5 }] }))
          .signedXml,
        'Invoice',
      ).errors,
    ).toBe('- validates');
  });
});
