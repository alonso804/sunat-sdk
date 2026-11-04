/**
 * Lote de facturas variadas contra BETA para validar que el redondeo y los tipos de afectación
 * coinciden con las reglas de cálculo de SUNAT (p. ej. 3291 "El cálculo del IGV es incorrecto").
 *
 *   pnpm tsx scripts/beta-matrix.ts [cantidad=15] [semilla=1]
 */
import { type InvoiceInput, SunatClient, SunatFaultError, SunatTransportError } from '../src';
import { sampleInvoice, TEST_ISSUER, testCertificate } from '../test/helpers';

const count = Number(process.argv[2] ?? 15);
let seed = Number(process.argv[3] ?? 1);

/** PRNG determinista (mulberry32) para poder reproducir una corrida. */
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const QUANTITIES = [1, 2, 3, 5, 7.5, 12, 0.5, 100, 2.25, 48, 0.125, 1000] as const;
const UNITS = ['NIU', 'KGM', 'MTR', 'ZZ', 'LTR'] as const;

function randomPrice(): number {
  // Precios minúsculos (tornillos, clavos) por cantidades grandes son los casos duros de redondeo.
  if (random() < 0.25) return pick([0.05, 0.1, 0.15, 0.35, 0.59, 0.99]);
  const decimals = pick([2, 2, 2, 3]);
  return Number((0.4 + random() * 400).toFixed(decimals));
}

function randomInvoice(number: number): InvoiceInput {
  const lines = 1 + Math.floor(random() * 8);
  return sampleInvoice({
    number,
    issuedAt: new Date(),
    currency: pick(['PEN', 'PEN', 'PEN', 'USD'] as const),
    items: Array.from({ length: lines }, (_, i) => ({
      description: `ARTICULO DE PRUEBA ${i + 1} "ESPECIAL" & CIA`,
      quantity: pick(QUANTITIES),
      unit: pick(UNITS),
      unitPrice: randomPrice(),
      igvAffectation: pick(['10', '10', '10', '10', '20', '30'] as const),
      ...(random() > 0.5 ? { productCode: `COD${i + 1}` } : {}),
    })),
  });
}

const { key } = testCertificate();
const client = new SunatClient({
  environment: 'beta',
  issuer: TEST_ISSUER,
  sol: { user: 'MODDATOS', password: 'MODDATOS' },
  signingKey: key,
});

let base = Math.floor(Date.now() / 1000) % 98_000_000;
let ok = 0;
const failures: string[] = [];

for (let i = 1; i <= count; i++) {
  const input = randomInvoice(++base);
  const prepared = client.prepareInvoice(input);
  const s = prepared.summary;
  const label = `#${i} ${prepared.baseName} ${s.currency} ${s.lines.length} líneas total=${s.total} igv=${s.igv}`;
  await sleep(2000);
  try {
    const result = await client.sendInvoice(prepared);
    if (result.status === 'accepted' || result.status === 'accepted_with_observations') {
      ok++;
      console.log(
        `✔ ${label}${result.status === 'accepted_with_observations' ? ` (obs: ${result.cdr.notes.join(' | ')})` : ''}`,
      );
    } else {
      failures.push(label);
      console.log(`✘ ${label}\n    ${result.code}: ${result.message}`);
      console.log('    líneas:', JSON.stringify(input.items));
    }
  } catch (error) {
    failures.push(label);
    const detail =
      error instanceof SunatFaultError
        ? `${error.kind} ${error.code}: ${error.sunatMessage}`
        : error instanceof SunatTransportError
          ? `transporte HTTP ${error.httpStatus}: ${error.message}`
          : String(error);
    console.log(`✘ ${label}\n    ${detail}`);
  }
}

console.log(`\nResumen: ${ok}/${count} aceptadas, ${failures.length} con problemas.`);
process.exitCode = failures.length > 0 ? 1 : 0;
