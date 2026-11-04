/**
 * Prueba manual contra el ambiente BETA de SUNAT (no tiene efecto tributario).
 *
 *   pnpm tsx scripts/beta-smoke.ts [sha1|sha256]
 *
 * Usa el RUC de pruebas 20000000001, usuario MODDATOS y un certificado autofirmado.
 */
import { SunatClient } from '../src';
import type { SignatureAlgorithm } from '../src/signing/xmldsig';
import { sampleInvoice, TEST_ISSUER, testCertificate } from '../test/helpers';

const algorithm = (process.argv[2] ?? 'sha1') as SignatureAlgorithm;
// Escenarios para observar respuestas reales de error: ok | badpass | future
const scenario = process.argv[3] ?? 'ok';
const { key } = testCertificate();

/** Muestra la respuesta cruda de SUNAT para poder diagnosticar rechazos. */
const loggingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const body = await response.clone().text();
  console.log(`\n--- HTTP ${response.status} ${response.statusText}`);
  console.log(body.length > 1500 ? `${body.slice(0, 1500)}… (${body.length} caracteres)` : body);
  return response;
};

const client = new SunatClient({
  environment: 'beta',
  issuer: TEST_ISSUER,
  sol: {
    user: process.env.SUNAT_SOL_USER ?? 'MODDATOS',
    password: scenario === 'badpass' ? 'CLAVE-INCORRECTA' : (process.env.SUNAT_SOL_PASSWORD ?? 'MODDATOS'),
  },
  signingKey: key,
  signatureAlgorithm: algorithm,
  fetch: loggingFetch,
});

// Correlativo distinto en cada corrida para no chocar con envíos anteriores.
const number = Math.floor(Date.now() / 1000) % 99_999_999;
const issuedAt = scenario === 'future' ? new Date(Date.now() + 10 * 24 * 3600 * 1000) : new Date();
const prepared = client.prepareInvoice(sampleInvoice({ number, issuedAt }));

console.log(`Enviando ${prepared.baseName} (firma ${algorithm}) a BETA…`);
console.log('Resumen:', JSON.stringify(prepared.summary, null, 2));

const result = await client.sendInvoice(prepared);
console.log(
  '\nRESULTADO:',
  JSON.stringify(result, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v), 2),
);
