/**
 * Envía a BETA facturas con tildes y símbolos para ver qué acepta SUNAT (sin efecto tributario).
 *   pnpm tsx scripts/beta-encoding.ts
 */
import { SunatClient } from '../src';
import { TEST_ISSUER, sampleInvoice, testCertificate } from '../test/helpers';

const client = new SunatClient({
  environment: 'beta',
  issuer: TEST_ISSUER,
  sol: { user: 'MODDATOS', password: 'MODDATOS' },
  signingKey: testCertificate().key,
});

const cases: Array<[string, string]> = [
  ['tildes y ñ', 'Cañería de PVC ÁÉÍÓÚ áéíóú Ññ Üü'],
  ['símbolos latinos', 'Tubo ½" 90° – Cía. «oferta» ¿ok? ¡sí!'],
  ['fuera de Latin-1 (€ “ ” — Ω)', 'Precio en € “especial” — Ω'],
];

let n = Math.floor(Date.now() / 1000) % 98_000_000;
for (const [label, description] of cases) {
  await new Promise((r) => setTimeout(r, 2500));
  const prepared = client.prepareInvoice(sampleInvoice({ number: ++n, issuedAt: new Date(), items: [{ description, quantity: 1, unitPrice: 11.8 }] }));
  try {
    const result = await client.sendInvoice(prepared);
    console.log(`${label.padEnd(30)} → ${result.status}${result.status === 'rejected' ? ` ${result.code}: ${result.message}` : ''}`);
  } catch (error) {
    console.log(`${label.padEnd(30)} → ERROR ${(error as Error).message}`);
  }
}
