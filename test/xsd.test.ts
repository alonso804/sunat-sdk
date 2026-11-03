import { describe, expect, it } from 'vitest';
import { SunatClient } from '../src';
import { TEST_ISSUER, hasXmllint, sampleDespatch, sampleInvoice, testCertificate, validateAgainstUbl } from './helpers';

/**
 * Validación contra los esquemas UBL 2.1 oficiales. SUNAT valida el XML con ellos
 * (el error `cvc-particle` que devolvió beta es de ese tipo), así que aquí detectamos
 * localmente los mismos problemas de estructura sin enviar nada.
 */
describe.skipIf(!hasXmllint)('esquema UBL 2.1 (xmllint)', () => {
  const { key } = testCertificate();
  const client = new SunatClient({
    environment: 'beta',
    issuer: TEST_ISSUER,
    sol: { user: 'MODDATOS', password: 'MODDATOS' },
    signingKey: key,
  });

  it('el validador detecta un XML defectuoso (control)', () => {
    const broken = client.prepareInvoice(sampleInvoice()).signedXml.replace(/<cbc:IssueDate>[^<]*<\/cbc:IssueDate>/, '');
    const result = validateAgainstUbl(broken, 'Invoice');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('IssueDate');
  });

  it('una factura firmada es válida', () => {
    const result = validateAgainstUbl(client.prepareInvoice(sampleInvoice()).signedXml, 'Invoice');
    expect(result.errors).toBe('- validates');
    expect(result.valid).toBe(true);
  });

  it('una GRE con transporte privado es válida', () => {
    const result = validateAgainstUbl(client.prepareDespatch(sampleDespatch()).signedXml, 'DespatchAdvice');
    expect(result.errors).toBe('- validates');
  });

  it('una GRE con transporte público, motivo 04 y datos completos es válida', () => {
    const prepared = client.prepareDespatch(
      sampleDespatch({
        reason: '04',
        recipient: undefined,
        transportMode: 'public',
        carrier: { ruc: '20131312955', name: 'TRANSPORTES DE PRUEBA SAC', mtcRegistration: 'MTC-123' },
        vehicle: { plate: 'XYZ987' },
        drivers: [
          { kind: 'Principal', docNumber: '12345678', firstName: 'JUAN', lastName: 'PEREZ', license: 'Q12345678' },
          { kind: 'Secundario', docNumber: '87654321', firstName: 'LUIS', lastName: 'GARCIA', license: 'Q87654321' },
        ],
        indicators: { plannedTransshipment: true, carrierVehicleAndDrivers: true },
        origin: { ubigeo: '150101', address: 'ALMACEN CENTRAL', establishmentCode: '0000' },
        destination: { ubigeo: '150114', address: 'TIENDA LA MOLINA', establishmentCode: '0001' },
        note: 'Entrega en horario de oficina',
        items: [
          { description: 'TUBO PVC 1/2" X 5 M', quantity: '24.5', unit: 'MTR', code: 'TUB05', sunatProductCode: '30181500', gtin: '7750000000017' },
        ],
        relatedDocuments: [
          { type: '01', number: 'F001-123', issuerRuc: '20000000001' },
          { type: '80', number: 'DET-0001' },
        ],
      }),
    );
    const result = validateAgainstUbl(prepared.signedXml, 'DespatchAdvice');
    expect(result.errors).toBe('- validates');
  });

  it('una GRE de transporte privado M1/L sin placa ni conductor (el caso habitual del negocio) es válida', () => {
    const prepared = client.prepareDespatch(
      sampleDespatch({ vehicle: undefined, drivers: [], indicators: { m1lVehicle: true }, items: [{ description: 'Chaleco Talla S', quantity: 2 }] }),
    );
    expect(validateAgainstUbl(prepared.signedXml, 'DespatchAdvice').errors).toBe('- validates');
  });

  it('una GRE con motivo "otros" y comprador es válida', () => {
    const prepared = client.prepareDespatch(
      sampleDespatch({
        reason: '13',
        reasonDescription: 'Préstamo de herramientas',
        buyer: { docType: '1', docNumber: '12345678', name: 'MARIA LOPEZ' },
      }),
    );
    expect(validateAgainstUbl(prepared.signedXml, 'DespatchAdvice').errors).toBe('- validates');
  });
});
