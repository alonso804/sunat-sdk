/**
 * Emisión de UNA factura en PRODUCCIÓN, con salvaguardas. Una factura aceptada es un documento tributario REAL:
 * no hay forma de probar en producción sin efectos. Por eso este script nunca envía sin tu confirmación escrita.
 *
 *   pnpm tsx --env-file=.env scripts/invoice-prod-send.ts <archivo.json> [etapa]
 *
 * Etapas:
 *   plan    (por defecto) Sin red. Valida la factura, calcula totales, arma y firma el XML y muestra el resumen
 *           completo (total, cuotas, orden de compra, guía relacionada). No contacta a SUNAT.
 *   status  Solo lectura. Pregunta a SUNAT (getStatusCdr) si ya existe esa serie y número. Úsala si un envío
 *           terminó en error de red: ANTES de pensar en otro número, comprueba si SUNAT sí lo recibió.
 *   send    Consulta primero (solo lectura) que el número esté libre; muestra el resumen y pide escribir
 *           ENVIAR <nombre>. Solo entonces envía. Guarda XML firmado y CDR en out/ (carpeta ignorada por git).
 *
 * El archivo JSON tiene la misma forma que `prepareInvoice` (ver scripts/examples/invoice.example.json), sin
 * `issuedAt`: la fecha de emisión es el momento del envío. Guarda tu archivo real en out/ (no se sube a git).
 *
 * Confirmación sin terminal interactiva (prefijo `!` de Claude Code):
 *   INVOICE_CONFIRM="ENVIAR <nombre>" pnpm tsx --env-file=.env scripts/invoice-prod-send.ts out/factura.json send
 *
 * Variables de entorno (ver .env.example): las mismas de los otros scripts, más opcionales:
 *   SUNAT_TRADE_NAME            Nombre comercial que sale arriba en la factura (p. ej. "MI EMPRESA E.I.R.L.").
 *   SUNAT_SIGNATURE_ALGORITHM   sha1 (por defecto, lo que documenta el manual) o sha256. Si SUNAT rechaza la firma
 *                               en producción, prueba con sha256 (el correlativo se consume con un rechazo, no con
 *                               una excepción 0100–1999).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  SunatClient,
  SunatFaultError,
  SunatTransportError,
  SunatValidationError,
  signingKeyFromPfx,
  type InvoiceInput,
  type PreparedInvoice,
} from '../src';
import { testCertificate } from '../test/helpers';

const file = process.argv[2];
const stage = process.argv[3] ?? 'plan';
if (!file || !['plan', 'status', 'send'].includes(stage)) {
  console.error('Uso: invoice-prod-send.ts <archivo.json> [plan|status|send]');
  process.exit(2);
}

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta la variable de entorno ${name}. Revisa .env.example.`);
    process.exit(2);
  }
  return value;
};
const optional = (name: string): string | undefined => process.env[name] || undefined;

const algorithm = optional('SUNAT_SIGNATURE_ALGORITHM') ?? 'sha1';
if (algorithm !== 'sha1' && algorithm !== 'sha256') {
  console.error('SUNAT_SIGNATURE_ALGORITHM debe ser sha1 o sha256.');
  process.exit(2);
}

const signingKey =
  stage === 'plan' && !process.env.SUNAT_CERT_PATH
    ? (console.log('(plan) Sin SUNAT_CERT_PATH: se firma con un certificado autofirmado descartable.'), testCertificate().key)
    : signingKeyFromPfx(readFileSync(need('SUNAT_CERT_PATH')), need('SUNAT_CERT_PASSWORD'));

const client = new SunatClient({
  environment: 'production',
  issuer: {
    ruc: need('SUNAT_RUC'),
    legalName: need('SUNAT_LEGAL_NAME'),
    ...(optional('SUNAT_TRADE_NAME') ? { tradeName: optional('SUNAT_TRADE_NAME') as string } : {}),
    address: {
      ubigeo: need('SUNAT_UBIGEO'),
      department: need('SUNAT_DEPARTMENT'),
      province: need('SUNAT_PROVINCE'),
      district: need('SUNAT_DISTRICT'),
      street: need('SUNAT_ADDRESS'),
    },
  },
  sol: {
    user: stage === 'plan' ? (optional('SUNAT_SOL_USER') ?? 'USUARIO') : need('SUNAT_SOL_USER'),
    password: stage === 'plan' ? (optional('SUNAT_SOL_PASSWORD') ?? 'clave') : need('SUNAT_SOL_PASSWORD'),
  },
  signingKey,
  signatureAlgorithm: algorithm,
});

function printError(error: unknown): never {
  if (error instanceof SunatValidationError) {
    console.error(`\nDatos inválidos (no se contactó a SUNAT): ${error.message}`);
    for (const issue of error.issues) console.error(`   - ${issue.path}: ${issue.message}`);
  } else if (error instanceof SunatFaultError) {
    console.error(`\nSUNAT respondió con una excepción ${error.code}: ${error.sunatMessage}`);
    if (error.kind === 'exception') console.error('   Excepción (0100–1999): el comprobante quedó NO informado. Corrige y reenvía con el MISMO número.');
    else if (error.kind === 'rejected') console.error('   Rechazo (2000–3999): el número quedó CONSUMIDO. Corrige y emite con el SIGUIENTE número.');
    console.error('   Si habla de usuario, clave o perfil: revisa los permisos del usuario secundario en SOL (Modificar Programas).');
  } else if (error instanceof SunatTransportError) {
    console.error(`\nError de red: ${error.message}`);
    console.error('   NO generes otro número. Corre la etapa "status" para saber si SUNAT recibió la factura antes de reenviarla.');
  } else console.error('\nError inesperado:', error);
  process.exit(1);
}

function prepare(): { prepared: PreparedInvoice; input: InvoiceInput } {
  const input = JSON.parse(readFileSync(file as string, 'utf8')) as InvoiceInput;
  if ('issuedAt' in input) {
    console.error('El archivo no debe llevar "issuedAt": la fecha de emisión es el momento del envío.');
    process.exit(2);
  }
  return { prepared: client.prepareInvoice(input), input };
}

function show(prepared: PreparedInvoice): void {
  const s = prepared.summary;
  console.log(`\nFactura ${s.series}-${s.number}  (${prepared.baseName})`);
  console.log(`Fecha de emisión: ${prepared.issuedAt.toISOString()} (hora de Lima en el XML)`);
  console.log('\nResumen:');
  console.log(JSON.stringify(s, null, 2));
}

try {
  const { prepared } = prepare();

  if (stage === 'plan') {
    show(prepared);
    console.log(`\nValidada y firmada (${algorithm}). Nada se envió: etapa sin red.`);
  }

  if (stage === 'status') {
    const { series, number } = prepared.summary;
    console.log(`Consultando en PRODUCCIÓN (solo lectura) ${series}-${number}…`);
    const result = await client.getInvoiceStatus({ series, number });
    console.log(`SUNAT respondió: código=${result.statusCode}  mensaje=${result.statusMessage}`);
    if (result.cdr) console.log(`CDR: ${result.cdr.referenceId} → ${result.cdr.description}  (la factura EXISTE en SUNAT)`);
  }

  if (stage === 'send') {
    const { series, number } = prepared.summary;
    console.log(`Comprobando (solo lectura) que ${series}-${number} esté libre en SUNAT…`);
    const existing = await client.getInvoiceStatus({ series, number });
    console.log(`SUNAT respondió: código=${existing.statusCode}  mensaje=${existing.statusMessage}`);
    if (existing.cdr) {
      console.error(`\n${series}-${number} YA EXISTE en SUNAT (${existing.cdr.description}). No se envía nada. Usa el siguiente número.`);
      process.exit(1);
    }

    show(prepared);
    console.log('\n*** ESTO CREA UNA FACTURA REAL EN SUNAT. Tiene efectos tributarios y no se deshace con un botón. ***');
    let answer = process.env.INVOICE_CONFIRM ?? '';
    if (!answer) {
      if (!process.stdin.isTTY) {
        console.log('\nEsta terminal no es interactiva, así que no puedo pedirte la confirmación. Nada se envió.');
        console.log(`Vuelve a correrlo con:  INVOICE_CONFIRM="ENVIAR ${prepared.baseName}" pnpm tsx --env-file=.env scripts/invoice-prod-send.ts ${file} send`);
        process.exit(0);
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      answer = await rl.question(`Escribe exactamente  ENVIAR ${prepared.baseName}  para confirmar: `);
      rl.close();
    }
    if (answer.trim() !== `ENVIAR ${prepared.baseName}`) {
      console.log('Cancelado. No se envió nada.');
      process.exit(0);
    }

    const result = await client.sendInvoice(prepared);
    if (result.status === 'rejected') {
      console.error(`\nRECHAZADA  código=${result.code}  mensaje=${result.message}`);
      console.error(`El número ${series}-${number} quedó CONSUMIDO. Corrige y emite con el siguiente número.`);
      process.exit(1);
    }
    console.log(`\n${result.status.toUpperCase()}  ${result.cdr.description}`);
    if (result.cdr.notes.length > 0) console.log(`Observaciones de SUNAT: ${result.cdr.notes.join(' | ')}`);
    mkdirSync('out', { recursive: true });
    writeFileSync(`out/${prepared.baseName}.xml`, prepared.signedXml);
    writeFileSync(`out/R-${prepared.baseName}.zip`, result.cdrZip);
    writeFileSync(`out/${prepared.baseName}.json`, JSON.stringify({ summary: prepared.summary, status: result.status, cdr: result.cdr }, null, 2));
    console.log(`Guardados en out/: XML firmado, CDR (zip) y resumen (${prepared.baseName}.*). Guárdalos también en tu base de datos.`);
  }
} catch (error) {
  printError(error);
}
