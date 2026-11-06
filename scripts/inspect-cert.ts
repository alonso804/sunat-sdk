/**
 * Revisa tu certificado digital (PFX / P12) SIN enviar nada a SUNAT.
 *
 *   pnpm tsx --env-file=.env scripts/inspect-cert.ts
 *
 * Variables: SUNAT_CERT_PATH, SUNAT_CERT_PASSWORD y, opcional, SUNAT_RUC (comprueba que el certificado
 * sea de ese RUC). No imprime la llave privada ni la contraseña.
 */
import { readFileSync } from 'node:fs';
import { checkCertificate, describeCertificate, signingKeyFromPfx } from '../src';
import { type SignatureAlgorithm, signUblXml, verifyUblSignature } from '../src/signing/xmldsig';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta la variable de entorno ${name}. Revisa .env.example.`);
    process.exit(2);
  }
  return value;
};

const path = need('SUNAT_CERT_PATH');
const password = need('SUNAT_CERT_PASSWORD');
const ruc = process.env.SUNAT_RUC || undefined;

let key: ReturnType<typeof signingKeyFromPfx>;
try {
  key = signingKeyFromPfx(new Uint8Array(readFileSync(path)), password);
} catch (error) {
  console.error(`\nNo se pudo abrir el certificado en ${path}:\n  ${(error as Error).message}`);
  process.exit(1);
}

const info = describeCertificate(key.certificatePem);
const check = checkCertificate(info, ruc ? { ruc } : {});
const show = (record: Record<string, string>): string =>
  Object.entries(record)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

console.log('\nCertificado');
console.log(`  Titular:      ${show(info.subject)}`);
console.log(`  Emitido por:  ${show(info.issuer)}`);
console.log(`  Serie:        ${info.serialNumber}`);
console.log(
  `  Vigencia:     ${info.notBefore.toISOString().slice(0, 10)} → ${info.notAfter.toISOString().slice(0, 10)}  (${check.daysRemaining} días restantes)`,
);
console.log(`  Llave:        RSA ${info.keyBits} bits · firmado con ${info.signatureAlgorithm}`);
console.log(`  Huella SHA-256: ${info.fingerprintSha256}`);

// Prueba de ida y vuelta: firma un documento mínimo y verifica la firma con el certificado.
const probe =
  '<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" ' +
  'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">' +
  '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions></Invoice>';
console.log('\nPrueba de firma local (no se envía nada)');
let signingOk = true;
for (const algorithm of ['sha1', 'sha256'] as SignatureAlgorithm[]) {
  try {
    const ok = verifyUblSignature(signUblXml(probe, key, algorithm), key.certificatePem);
    console.log(`  ${algorithm.padEnd(6)} ${ok ? 'OK' : 'FALLÓ la verificación'}`);
    signingOk &&= ok;
  } catch (error) {
    console.log(`  ${algorithm.padEnd(6)} ERROR: ${(error as Error).message}`);
    signingOk = false;
  }
}

if (check.warnings.length) console.log(`\nAvisos:\n${check.warnings.map((w) => `  - ${w}`).join('\n')}`);
if (check.problems.length) console.log(`\nProblemas:\n${check.problems.map((p) => `  - ${p}`).join('\n')}`);
console.log(
  check.ok && signingOk
    ? '\nEl certificado se puede usar para firmar.'
    : '\nHay problemas: revisa los mensajes de arriba.',
);
process.exit(check.ok && signingOk ? 0 : 1);
