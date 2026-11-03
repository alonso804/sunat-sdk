import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCertificate, describeCertificate, signingKeyFromPfx } from '../src';
import { signUblXml, verifyUblSignature } from '../src/signing/xmldsig';
import { TEST_RUC, testCertificate } from './helpers';

const { key } = testCertificate();

describe('describeCertificate', () => {
  it('informa titular, vigencia, llave, algoritmo y huella', () => {
    const info = describeCertificate(key.certificatePem);
    expect(info.subject.OU).toBe(TEST_RUC);
    expect(info.keyBits).toBe(2048);
    expect(info.signatureAlgorithm).toBe('sha256WithRSAEncryption');
    expect(info.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});

describe('textos con tildes en el certificado', () => {
  it('muestra "Identificación" y no "IdentificaciÃ³n" (campos UTF8String)', async () => {
    const forge = (await import('node-forge')).default;
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '02';
    cert.validity.notBefore = new Date(Date.now() - 1000);
    cert.validity.notAfter = new Date(Date.now() + 86_400_000);
    // forge codifica en UTF-8 al armar el certificado cuando el campo es UTF8String.
    const subject = [
      { name: 'organizationName', value: 'Registro Nacional de Identificación y Estado Civil', valueTagClass: forge.asn1.Type.UTF8 as never },
    ];
    cert.setSubject(subject);
    cert.setIssuer(subject);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const info = describeCertificate(forge.pki.certificateToPem(cert));
    expect(info.issuer.O).toBe('Registro Nacional de Identificación y Estado Civil');
  });
});

describe('checkCertificate', () => {
  const info = describeCertificate(key.certificatePem);

  it('acepta un certificado vigente que contiene el RUC', () => {
    const check = checkCertificate(info, { ruc: TEST_RUC });
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
    expect(check.warnings).toEqual([]);
    expect(check.daysRemaining).toBeGreaterThan(300);
  });

  it('detecta un certificado vencido o aún no vigente', () => {
    expect(checkCertificate(info, { now: new Date(info.notAfter.getTime() + 86_400_000) }).problems.join()).toContain('venció');
    expect(checkCertificate(info, { now: new Date(info.notBefore.getTime() - 86_400_000) }).problems.join()).toContain('aún no es válido');
  });

  it('avisa cuando vence pronto', () => {
    const soon = new Date(info.notAfter.getTime() - 10 * 86_400_000);
    const check = checkCertificate(info, { now: soon });
    expect(check.ok).toBe(true);
    expect(check.warnings.join()).toContain('vence en 10 días');
  });

  it('avisa si el RUC no aparece en el titular', () => {
    expect(checkCertificate(info, { ruc: '20131312955' }).warnings.join()).toContain('No encontré el RUC');
  });
});

/**
 * Compatibilidad con los distintos formatos de PKCS#12 que puede entregar una entidad de certificación
 * (cifrado moderno de OpenSSL 3, 3DES/RC2 antiguo, con o sin cadena de certificados).
 * Se generan con la CLI de `openssl`; si no existe o no soporta una opción, esa variante se omite.
 */
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

describe.skipIf(!hasOpenssl)('PKCS#12 generado con openssl', () => {
  let dir = '';
  const variants: Record<string, string[]> = {
    'cifrado por defecto de OpenSSL 3 (AES-256, PBKDF2-SHA256)': [],
    'AES-128 con MAC SHA1': ['-keypbe', 'AES-128-CBC', '-certpbe', 'AES-128-CBC', '-macalg', 'SHA1'],
    '3DES con MAC SHA1': ['-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'SHA1'],
    'legado 3DES/RC2-40 (-legacy)': ['-legacy'],
  };
  const built = new Map<string, { chain: boolean; file: string }[]>();

  const run = (args: string[]) => spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sunat-sdk-pfx-'));
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/C=PE/O=CA DE PRUEBA/CN=CA', '-days', '30']);
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', `/C=PE/O=NEGOCIO DE PRUEBA/OU=${TEST_RUC}/CN=NEGOCIO`]);
    run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '30', '-sha256']);

    let index = 0;
    for (const [name, extra] of Object.entries(variants)) {
      const outputs: { chain: boolean; file: string }[] = [];
      for (const chain of [false, true]) {
        const file = `v${index++}.p12`;
        const args = ['pkcs12', '-export', '-out', file, '-inkey', 'leaf.key', '-in', 'leaf.pem', '-passout', 'pass:secreto', ...extra, ...(chain ? ['-certfile', 'ca.pem'] : [])];
        if (run(args).status === 0) outputs.push({ chain, file });
      }
      built.set(name, outputs);
    }
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('se generó al menos una variante', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.p12')).length).toBeGreaterThan(0);
  });

  for (const name of Object.keys(variants)) {
    it(`abre y firma con: ${name}`, () => {
      const outputs = built.get(name) ?? [];
      for (const { chain, file } of outputs) {
        const loaded = signingKeyFromPfx(new Uint8Array(readFileSync(join(dir, file))), 'secreto');
        // Con cadena en el PFX debe elegir el certificado del titular (no el de la CA).
        expect(describeCertificate(loaded.certificatePem).subject.OU, `${file} (cadena: ${chain})`).toBe(TEST_RUC);
        const xml =
          '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">' +
          '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions></Invoice>';
        expect(verifyUblSignature(signUblXml(xml, loaded, 'sha1'), loaded.certificatePem)).toBe(true);
      }
    });
  }

  it('rechaza una contraseña incorrecta con un mensaje claro', () => {
    const [first] = [...built.values()].flat();
    expect(first).toBeDefined();
    expect(() => signingKeyFromPfx(new Uint8Array(readFileSync(join(dir, first!.file))), 'otra')).toThrow(/contraseña/);
  });
});
