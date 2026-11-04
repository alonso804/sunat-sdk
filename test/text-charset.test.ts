import { describe, expect, it } from 'vitest';
import { SunatClient, TextCharset } from '../src';
import { verifyUblSignature } from '../src/signing/xmldsig';
import { toLatin1Deep, toLatin1Text } from '../src/text-charset';
import { TEST_ISSUER, sampleDespatch, sampleInvoice, testCertificate } from './helpers';

const { key } = testCertificate();
/** El texto del caso 3 de la prueba en beta (aceptado tal cual por SUNAT). */
const OUTSIDE_LATIN1 = 'Precio en € “especial” — Ω';

describe('toLatin1Text', () => {
  it('no cambia nada que ya sea Latin-1: tildes, ñ y símbolos latinos', () => {
    const latin1 = 'Cañería de PVC ÁÉÍÓÚ áéíóú Ññ Üü ½" 90° «oferta» ¿ok? ¡sí! N° 3 & Cía.';
    expect(toLatin1Text(latin1)).toBe(latin1);
  });

  it('cambia los signos tipográficos por equivalentes simples y quita lo que no tiene equivalente', () => {
    expect(toLatin1Text(OUTSIDE_LATIN1)).toBe('Precio en EUR "especial" - ');
    expect(toLatin1Text('‘a’ – b … c • d ™ № 5')).toBe("'a' - b ... c - d TM No 5");
  });

  it('simplifica letras de otros idiomas, ancho completo y ligaduras', () => {
    expect(toLatin1Text('Žilina č ő')).toBe('Zilina c o');
    expect(toLatin1Text('ＡＢＣ ﬁ ①')).toBe('ABC fi 1');
  });

  it('cambia espacios especiales por espacios y quita invisibles y emojis', () => {
    expect(toLatin1Text('A\u2009B\u200BC')).toBe('A BC');
    expect(toLatin1Text('Cemento 👍 OK')).toBe('Cemento  OK');
  });
});

describe('toLatin1Deep', () => {
  it('convierte los textos de objetos y arrays, y deja igual números y fechas', () => {
    const date = new Date('2026-11-04T10:00:00-05:00');
    const out = toLatin1Deep({ a: '“x”', n: 3, d: date, list: [{ b: 'y — z' }], none: undefined });
    expect(out).toEqual({ a: '"x"', n: 3, d: date, list: [{ b: 'y - z' }], none: undefined });
    expect(out.d).toBe(date);
  });
});

describe('SunatClient con textCharset', () => {
  const makeClient = (textCharset?: TextCharset) =>
    new SunatClient({
      environment: 'beta',
      issuer: { ...TEST_ISSUER, legalName: 'EMPRESA “PRUEBAS” SAC' },
      sol: { user: 'MODDATOS', password: 'MODDATOS' },
      signingKey: key,
      ...(textCharset ? { textCharset } : {}),
    });
  const invoiceWith = (client: SunatClient) =>
    client.prepareInvoice(
      sampleInvoice({ note: 'Entrega — Peñuelas', items: [{ description: OUTSIDE_LATIN1, quantity: 1, unitPrice: 11.8 }] }),
    );

  it('por defecto (unicode) envía el texto tal cual', () => {
    const client = makeClient();
    expect(client.issuer.legalName).toBe('EMPRESA “PRUEBAS” SAC');
    const prepared = invoiceWith(client);
    expect(prepared.signedXml).toContain('Precio en € “especial” — Ω');
    expect(prepared.summary.lines[0]!.description).toBe(OUTSIDE_LATIN1);
  });

  it('con latin1 convierte el texto del emisor y de la factura antes de firmar, y el summary lo muestra', () => {
    const client = makeClient(TextCharset.latin1);
    expect(client.issuer.legalName).toBe('EMPRESA "PRUEBAS" SAC');
    const prepared = invoiceWith(client);
    // Al firmar, el XML se vuelve a serializar y las comillas quedan sin escapar dentro del texto (es XML válido).
    expect(prepared.signedXml).toContain('<cbc:Description>Precio en EUR "especial" -</cbc:Description>');
    expect(prepared.signedXml).toContain('Entrega - Peñuelas'); // la ñ no cambia
    expect(prepared.signedXml).not.toMatch(/[€“”—Ω]/);
    expect(prepared.summary.lines[0]!.description).toBe('Precio en EUR "especial" - ');
    expect(verifyUblSignature(prepared.signedXml, key.certificatePem)).toBe(true);
  });

  it('con latin1 también convierte el texto de la guía', () => {
    const prepared = makeClient(TextCharset.latin1).prepareDespatch(
      sampleDespatch({ note: 'OC 45 — urgente', items: [{ description: 'Tubo ½" “PVC”', quantity: 2 }] }),
    );
    expect(prepared.signedXml).toContain('OC 45 - urgente');
    expect(prepared.signedXml).toContain('<cbc:Description>Tubo ½" "PVC"</cbc:Description>');
    expect(prepared.summary.items[0]!.description).toBe('Tubo ½" "PVC"');
    expect(verifyUblSignature(prepared.signedXml, key.certificatePem)).toBe(true);
  });
});
