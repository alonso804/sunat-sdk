import { XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { DespatchSchema, SunatClient, SunatValidationError } from '../src';
import { verifyUblSignature } from '../src/signing/xmldsig';
import { TEST_ISSUER, TEST_RUC, sampleDespatch, testCertificate } from './helpers';

const { key } = testCertificate();
const client = new SunatClient({
  environment: 'beta',
  issuer: TEST_ISSUER,
  sol: { user: 'MODDATOS', password: 'MODDATOS' },
  signingKey: key,
  now: () => new Date('2026-10-31T15:30:00-05:00'),
});

const issues = (input: unknown): string[] => {
  const result = DespatchSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('reglas de la GRE remitente (anexo 12, RS 000123-2022/SUNAT)', () => {
  it('acepta una GRE de venta con transporte privado', () => {
    expect(issues(sampleDespatch())).toEqual([]);
  });

  it('exige serie "T" + 3 caracteres', () => {
    expect(issues(sampleDespatch({ series: 'F001' })).join()).toContain('series');
    expect(issues(sampleDespatch({ series: 'T01' })).join()).toContain('series');
  });

  it('exige destinatario salvo en los motivos 02, 04 y 07', () => {
    expect(issues(sampleDespatch({ recipient: undefined })).join()).toContain('recipient');
    for (const reason of ['02', '04', '07'] as const) {
      const input = sampleDespatch({
        reason,
        recipient: undefined,
        ...(reason === '04'
          ? {
              origin: { ubigeo: '150101', address: 'A', establishmentCode: '0000' },
              destination: { ubigeo: '150114', address: 'B', establishmentCode: '0001' },
            }
          : {}),
      });
      expect(issues(input)).toEqual([]);
    }
  });

  it('el motivo 04 exige los códigos de establecimiento de partida y llegada', () => {
    const found = issues(sampleDespatch({ reason: '04', recipient: undefined })).join();
    expect(found).toContain('origin.establishmentCode');
    expect(found).toContain('destination.establishmentCode');
  });

  it('el motivo 13 exige descripción y el 03 exige comprador', () => {
    expect(issues(sampleDespatch({ reason: '13' })).join()).toContain('reasonDescription');
    expect(issues(sampleDespatch({ reason: '03' })).join()).toContain('buyer');
  });

  it('rechaza motivos no soportados (importación/exportación/itinerante)', () => {
    for (const reason of ['08', '09', '18']) {
      expect(DespatchSchema.safeParse({ ...sampleDespatch(), reason }).success).toBe(false);
    }
  });

  it('transporte privado exige placa y conductor', () => {
    const found = issues(sampleDespatch({ vehicle: undefined, drivers: [] })).join();
    expect(found).toContain('vehicle');
    expect(found).toContain('drivers');
  });

  it('transporte privado en vehículos M1/L no exige placa ni conductor (como en SOL)', () => {
    const input = sampleDespatch({ vehicle: undefined, drivers: [], indicators: { m1lVehicle: true } });
    expect(issues(input)).toEqual([]);
    const prepared = client.prepareDespatch(input);
    expect(prepared.signedXml).toContain('SUNAT_Envio_IndicadorTrasladoVehiculoM1L');
    // Como el XML de SOL: un TransportEquipment vacío (sin placa) y ningún conductor.
    expect(prepared.signedXml).toContain('<cac:TransportHandlingUnit><cac:TransportEquipment/></cac:TransportHandlingUnit>');
    expect(prepared.signedXml).not.toMatch(/<cac:TransportEquipment><cbc:ID>/);
    expect(prepared.signedXml).not.toContain('DriverPerson');
    expect(prepared.summary.vehiclePlate).toBeUndefined();
  });

  it('declara el indicador de bien regulado (catálogo 55, 7022) en cada bien: 0 por defecto, 1 si se indica', () => {
    const normal = client.prepareDespatch(sampleDespatch()).signedXml;
    expect(normal).toContain('<cbc:NameCode listAgencyName="PE:SUNAT" listName="Propiedad del item" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo55">7022</cbc:NameCode><cbc:Value>0</cbc:Value>');
    const base = sampleDespatch();
    const regulated = client.prepareDespatch({ ...base, items: [{ ...base.items[0]!, regulated: true }] }).signedXml;
    expect(regulated).toContain('>7022</cbc:NameCode><cbc:Value>1</cbc:Value>');
  });

  it('sin M1/L y con placa, el vehículo lleva su placa y no hay un TransportEquipment vacío', () => {
    const xml = client.prepareDespatch(sampleDespatch()).signedXml;
    expect(xml).toMatch(/<cac:TransportEquipment><cbc:ID>[A-Z0-9]+<\/cbc:ID><\/cac:TransportEquipment>/);
    expect(xml).not.toContain('<cac:TransportEquipment/>');
  });

  it('transporte público exige transportista (salvo vehículos M1/L)', () => {
    const base = sampleDespatch({ transportMode: 'public', vehicle: undefined, drivers: [] });
    expect(issues(base).join()).toContain('carrier');
    expect(issues({ ...base, indicators: { m1lVehicle: true } })).toEqual([]);
    expect(issues({ ...base, carrier: { ruc: '20131312955', name: 'TRANSPORTES SAC' } })).toEqual([]);
  });

  it('con el indicador de vehículo y conductores del transportista exige placa y conductores', () => {
    const input = sampleDespatch({
      transportMode: 'public',
      carrier: { ruc: '20131312955', name: 'TRANSPORTES SAC' },
      vehicle: undefined,
      drivers: [],
      indicators: { carrierVehicleAndDrivers: true },
    });
    const found = issues(input).join();
    expect(found).toContain('vehicle');
    expect(found).toContain('drivers');
  });

  it('valida RUC, DNI, placa, peso y fecha', () => {
    expect(issues(sampleDespatch({ recipient: { docType: '6', docNumber: '20000000002', name: 'X' } })).join()).toContain('RUC inválido');
    expect(issues(sampleDespatch({ recipient: { docType: '1', docNumber: '123', name: 'X' } })).join()).toContain('DNI');
    expect(issues(sampleDespatch({ vehicle: { plate: 'AB' } })).join()).toContain('placa');
    expect(issues(sampleDespatch({ grossWeight: { value: 0, unit: 'KGM' } })).join()).toContain('grossWeight');
    expect(issues(sampleDespatch({ transferStartDate: '2026-02-30' })).join()).toContain('transferStartDate');
  });

  it('normaliza la placa (mayúsculas, sin guiones ni espacios)', () => {
    const parsed = DespatchSchema.parse(sampleDespatch({ vehicle: { plate: 'ab-c 123' } }));
    expect(parsed.vehicle?.plate).toBe('ABC123');
  });
});

describe('prepareDespatch', () => {
  it('genera un XML bien formado, firmado y con los datos esperados', () => {
    const prepared = client.prepareDespatch(sampleDespatch());
    const xml = prepared.signedXml;

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(prepared.baseName).toBe(`${TEST_RUC}-09-T001-1`);
    expect(xml).toContain('<cbc:ID>T001-1</cbc:ID>');
    expect(xml).toContain('<cbc:IssueDate>2026-10-31</cbc:IssueDate>');
    expect(xml).toContain('<cbc:IssueTime>15:30:00</cbc:IssueTime>');
    expect(xml).toMatch(/<cbc:DespatchAdviceTypeCode [^>]*>09<\/cbc:DespatchAdviceTypeCode>/);
    expect(xml).toMatch(/<cbc:HandlingCode [^>]*>01<\/cbc:HandlingCode>/);
    expect(xml).toMatch(/<cbc:TransportModeCode [^>]*>02<\/cbc:TransportModeCode>/);
    expect(xml).toContain('<cbc:GrossWeightMeasure unitCode="KGM">425.500</cbc:GrossWeightMeasure>');
    expect(xml).toContain('<cbc:TotalTransportHandlingUnitQuantity>12</cbc:TotalTransportHandlingUnitQuantity>');
    expect(xml).toContain('<cac:TransitPeriod><cbc:StartDate>2026-11-02</cbc:StartDate></cac:TransitPeriod>');
    expect(xml).toContain('<cac:TransportEquipment><cbc:ID>ABC123</cbc:ID></cac:TransportEquipment>');
    expect(xml).toContain('<cbc:JobTitle>Principal</cbc:JobTitle>');
    expect(xml).toContain('<cbc:DeliveredQuantity unitCode="NIU">10.00</cbc:DeliveredQuantity>');
    expect(prepared.digestValue).toBeTruthy();
  });

  it('la firma se verifica y detecta alteraciones', () => {
    const { signedXml } = client.prepareDespatch(sampleDespatch());
    expect(verifyUblSignature(signedXml, key.certificatePem)).toBe(true);
    expect(verifyUblSignature(signedXml.replace('425.500', '999.000'), key.certificatePem)).toBe(false);
  });

  it('en los motivos 02, 04 y 07 el destinatario es el propio remitente', () => {
    const prepared = client.prepareDespatch(
      sampleDespatch({
        reason: '04',
        recipient: undefined,
        origin: { ubigeo: '150101', address: 'A', establishmentCode: '0000' },
        destination: { ubigeo: '150114', address: 'B', establishmentCode: '0001' },
      }),
    );
    expect(prepared.summary.recipient).toEqual({ docType: '6', docNumber: TEST_RUC, name: 'EMPRESA DE PRUEBAS SAC' });
    expect(prepared.signedXml).toContain(`<cbc:AddressTypeCode listID="${TEST_RUC}">0001</cbc:AddressTypeCode>`);
    expect(prepared.warnings.join(' ')).not.toContain('Buzón SOL'); // sin aviso a terceros
  });

  it('rechaza un destinatario distinto del remitente cuando el motivo lo prohíbe', () => {
    expect(() =>
      client.prepareDespatch(
        sampleDespatch({
          reason: '02',
          recipient: { docType: '6', docNumber: '20131312955', name: 'OTRA EMPRESA' },
        }),
      ),
    ).toThrow(SunatValidationError);
  });

  it('la fecha de inicio del traslado no puede ser anterior a la emisión', () => {
    expect(() => client.prepareDespatch(sampleDespatch({ transferStartDate: '2026-10-30' }))).toThrow(/anterior a la fecha de emisión/);
  });

  it('avisa del Buzón SOL del destinatario y de la baja en SOL', () => {
    const future = client.prepareDespatch(sampleDespatch());
    expect(future.warnings.join(' ')).toContain('dar de baja');
    expect(future.warnings.join(' ')).toContain('Buzón SOL');

    const today = client.prepareDespatch(sampleDespatch({ transferStartDate: '2026-10-31' }));
    expect(today.warnings.join(' ')).toContain('inicia hoy');
  });

  it('devuelve un resumen legible', () => {
    const { summary } = client.prepareDespatch(sampleDespatch());
    expect(summary.reason).toEqual({ code: '01', label: 'Venta' });
    expect(summary.grossWeight).toBe('425.500 KGM');
    expect(summary.vehiclePlate).toBe('ABC123');
    expect(summary.drivers).toEqual([{ name: 'JUAN PEREZ GOMEZ', docNumber: '12345678', license: 'Q12345678' }]);
    expect(summary.items).toHaveLength(2);
    expect(summary.relatedDocuments).toEqual([{ type: '01', label: 'Factura', number: 'F001-123' }]);
  });

  it('lanza SunatValidationError con el detalle de los campos inválidos', () => {
    try {
      client.prepareDespatch(sampleDespatch({ items: [] }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SunatValidationError);
      expect((error as SunatValidationError).issues.some((i) => i.path === 'items')).toBe(true);
    }
  });
});
