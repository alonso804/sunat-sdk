import { describe, expect, it } from 'vitest';
import { SunatClient } from '../src';
import type { SignatureAlgorithm } from '../src/signing/xmldsig';
import { sampleInvoice, TEST_ISSUER, testCertificate } from './helpers';

/**
 * Pruebas contra el ambiente BETA real de SUNAT (red). Se omiten salvo que se ejecuten con:
 *   pnpm test:beta
 *
 * Beta valida estructura XSD, firma y cálculos, pero NO valida la clave SOL ni las fechas,
 * y el proxy de SUNAT responde 401 si se envían peticiones muy seguidas (de ahí la pausa).
 */
const enabled = process.env.SUNAT_BETA === '1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)('SUNAT beta (red real)', () => {
  const { key } = testCertificate();
  let counter = Math.floor(Date.now() / 1000) % 99_000_000;

  const clientFor = (algorithm: SignatureAlgorithm) =>
    new SunatClient({
      environment: 'beta',
      issuer: TEST_ISSUER,
      sol: { user: 'MODDATOS', password: 'MODDATOS' },
      signingKey: key,
      signatureAlgorithm: algorithm,
    });

  it.each(['sha1', 'sha256'] as const)('acepta una factura firmada con %s', async (algorithm) => {
    await sleep(2_000);
    const client = clientFor(algorithm);
    const prepared = client.prepareInvoice(sampleInvoice({ number: ++counter, issuedAt: new Date() }));
    const result = await client.sendInvoice(prepared);

    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') {
      expect(result.cdr.referenceId).toBe(`F001-${counter}`);
      expect(result.cdr.description).toMatch(/aceptada/i);
    }
  });
});
