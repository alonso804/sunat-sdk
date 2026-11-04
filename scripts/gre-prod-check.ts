/**
 * Verificación de la API de guías de remisión (GRE) contra PRODUCCIÓN, por etapas y con salvaguardas.
 * SUNAT no tiene ambiente de pruebas para la GRE, así que cada etapa limita lo que puede pasar.
 *
 *   pnpm tsx --env-file=.env scripts/gre-prod-check.ts <etapa>
 *
 * Etapas (en este orden):
 *   plan      Sin red. Arma, firma y valida contra el esquema UBL la guía de prueba y muestra el resumen.
 *   auth      Solo pide el token (verifica client_id/secret, usuario y clave SOL). No crea ningún documento.
 *   negative  Envía una guía con un motivo de traslado inválido (código 99, que no existe en el catálogo 20),
 *             puesto en el XML DESPUÉS de validar y firmar. SUNAT debe rechazarla por regla de negocio y no
 *             registrar nada. Prueba envío, ticket y lectura de errores.
 *             OJO: el 2026-11-01 se comprobó que SUNAT NO valida la firma de una GRE (aceptó una guía con el
 *             peso alterado tras firmar), por eso aquí se altera una regla de negocio y no la firma. Si SUNAT
 *             también aceptara esta, quedaría una guía real: se da de baja en SOL (serie TZ01).
 *   positive  Emite UNA guía de prueba REAL (efecto en SUNAT). Pide confirmación escrita. Se puede dar de
 *             baja en SOL mientras el traslado no haya iniciado (art. 8 de la RS 000123-2022/SUNAT).
 *
 *   pdf       Sin enviar nada: lee el CDR guardado en out/ de una guía ya emitida (GRE_TEST_NUMBER, por defecto 1),
 *             toma la URL del QR y descarga el PDF oficial de SUNAT a out/. Es una sola petición de lectura.
 *
 * La guía de prueba usa el propio negocio como destinatario (no avisa a terceros), traslado privado en vehículo M1/L (como tu flujo habitual en SOL),
 * fecha de inicio 7 días en el futuro y una serie de pruebas aparte (por defecto TZ01). El portal SOL
 * emite con series EG##, así que no hay colisión con las series T## de un sistema propio.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  SunatApiError,
  SunatClient,
  SunatFaultError,
  SunatTransportError,
  SunatValidationError,
  signingKeyFromPfx,
  type DespatchInput,
  type PreparedDespatch,
} from '../src';
import { parseCdrXml } from '../src/cdr';
import { requestToken } from '../src/gre/api';
import { unzipFiles } from '../src/zip';
import { hasXmllint, testCertificate, validateAgainstUbl } from '../test/helpers';

const stage = process.argv[2] ?? 'plan';
if (!['plan', 'auth', 'negative', 'positive', 'pdf'].includes(stage)) {
  console.error('Uso: gre-prod-check.ts <plan|auth|negative|positive|pdf>');
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
const optional = (name: string, fallback: string): string => process.env[name] || fallback;

/** Fecha `YYYY-MM-DD` en hora de Lima, `days` días después de hoy. */
function limaDate(days: number): string {
  const date = new Date(Date.now() + days * 24 * 3600 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(date);
}

// --- Configuración (todo viene del entorno; nunca se imprimen secretos) --------------------------
const issuer = {
  ruc: need('SUNAT_RUC'),
  legalName: need('SUNAT_LEGAL_NAME'),
  address: {
    ubigeo: need('SUNAT_UBIGEO'),
    department: need('SUNAT_DEPARTMENT'),
    province: need('SUNAT_PROVINCE'),
    district: need('SUNAT_DISTRICT'),
    street: need('SUNAT_ADDRESS'),
  },
};

const useTestCertificate = stage === 'plan' && !process.env.SUNAT_CERT_PATH;
if (useTestCertificate) console.log('(plan) Sin SUNAT_CERT_PATH: se firma con un certificado autofirmado descartable.');
const signingKey = useTestCertificate
  ? testCertificate().key
  : signingKeyFromPfx(readFileSync(need('SUNAT_CERT_PATH')), need('SUNAT_CERT_PASSWORD'));

const solUser = stage === 'plan' ? optional('SUNAT_SOL_USER', 'USUARIO') : need('SUNAT_SOL_USER');
const solPassword = stage === 'plan' ? optional('SUNAT_SOL_PASSWORD', 'clave') : need('SUNAT_SOL_PASSWORD');
const greClientId = stage === 'plan' ? optional('GRE_CLIENT_ID', 'client-id') : need('GRE_CLIENT_ID');
const greClientSecret = stage === 'plan' ? optional('GRE_CLIENT_SECRET', 'client-secret') : need('GRE_CLIENT_SECRET');

const client = new SunatClient({
  environment: 'production',
  issuer,
  sol: { user: solUser, password: solPassword },
  gre: { clientId: greClientId, clientSecret: greClientSecret },
  signingKey,
});

function testDespatch(number: number): DespatchInput {
  const point = { ubigeo: issuer.address.ubigeo, address: issuer.address.street };
  return {
    series: optional('GRE_TEST_SERIES', 'TZ01'),
    number,
    reason: '13',
    reasonDescription: 'PRUEBA DE INTEGRACION - NO HAY TRASLADO',
    recipient: { docType: '6', docNumber: issuer.ruc, name: issuer.legalName },
    transportMode: 'private',
    transferStartDate: limaDate(7),
    grossWeight: { value: 1, unit: 'KGM' },
    origin: point,
    destination: point,
    // Igual que el flujo habitual en SOL: transporte privado en vehículo M1/L, sin placa ni conductor.
    indicators: { m1lVehicle: true },
    // Con tildes y ñ a propósito: tras la prueba se revisa en SOL (Consulta de GRE) cómo se ven.
    items: [{ description: 'PRUEBA DE INTEGRACIÓN - Cañería áéíóú Ññ - NO TRASLADAR', quantity: 1, unit: 'NIU' }],
    note: 'PRUEBA DE INTEGRACIÓN - OC 0001 - DAR DE BAJA EN SOL',
  };
}

function show(prepared: PreparedDespatch): void {
  console.log('\nResumen de la guía:');
  console.log(JSON.stringify(prepared.summary, null, 2));
  console.log('\nAvisos:');
  for (const warning of prepared.warnings) console.log(` - ${warning}`);
}

function checkSchema(prepared: PreparedDespatch): void {
  if (!hasXmllint) {
    console.log('\n(xmllint no está instalado: se omite la validación contra el esquema UBL)');
    return;
  }
  const result = validateAgainstUbl(prepared.signedXml, 'DespatchAdvice');
  console.log(`\nValidación contra el esquema UBL 2.1: ${result.valid ? 'OK' : `FALLÓ\n${result.errors}`}`);
  if (!result.valid) process.exit(1);
}

function printError(error: unknown): never {
  if (error instanceof SunatValidationError) console.error(`\nDatos inválidos (no se contactó a SUNAT): ${error.message}`);
  else if (error instanceof SunatApiError) {
    console.error(`\nSUNAT respondió HTTP ${error.status}${error.code ? ` (${error.code})` : ''}: ${error.message}`);
    for (const detail of error.details) console.error(`   - ${detail.code ?? ''} ${detail.message}`);
    if (error.isAuthError) console.error('   Revisa client_id/client_secret, usuario y clave SOL, y los permisos del usuario secundario.');
  } else if (error instanceof SunatTransportError) console.error(`\nError de red: ${error.message}`);
  else if (error instanceof SunatFaultError) console.error(`\nSUNAT ${error.code}: ${error.sunatMessage}`);
  else console.error('\nError inesperado:', error);
  process.exit(1);
}

function describe(result: Awaited<ReturnType<SunatClient['sendDespatch']>>): void {
  if (result.status === 'rejected') console.log(`\nResultado: RECHAZADA  código=${result.code}  mensaje=${result.message}`);
  else if (result.status === 'pending') console.log(`\nResultado: SUNAT sigue procesando. Ticket: ${result.ticket}`);
  else console.log(`\nResultado: ${result.status.toUpperCase()}  ${result.cdr.description}`);
}

try {
  if (stage === 'plan') {
    const prepared = client.prepareDespatch(testDespatch(1));
    show(prepared);
    checkSchema(prepared);
    console.log(`\nNombre de archivo: ${prepared.baseName}.zip  (nada se envió: etapa sin red)`);
  }

  if (stage === 'auth') {
    const token = await requestToken({
      clientId: greClientId,
      clientSecret: greClientSecret,
      username: `${issuer.ruc}${solUser}`,
      password: solPassword,
    });
    const minutes = Math.round((token.expiresAt - Date.now()) / 60_000);
    console.log(`Autenticación correcta. El token vence en ~${minutes} min. No se creó ningún documento.`);
  }

  if (stage === 'pdf') {
    const number = Number(optional('GRE_TEST_NUMBER', '1'));
    const baseName = `${issuer.ruc}-09-${optional('GRE_TEST_SERIES', 'TZ01')}-${number}`;
    const files = unzipFiles(new Uint8Array(readFileSync(`out/R-${baseName}.zip`)));
    const xmlBytes = Object.entries(files).find(([name]) => name.toLowerCase().endsWith('.xml'))?.[1];
    if (!xmlBytes) throw new Error(`El CDR out/R-${baseName}.zip no contiene un .xml.`);
    const cdr = parseCdrXml(Buffer.from(xmlBytes).toString('utf8'));
    if (!cdr.qrUrl) throw new Error('Este CDR no trae la URL del QR.');
    console.log(`CDR de ${cdr.referenceId}: ${cdr.description}`);
    console.log('URL del QR (es el texto exacto que debe codificar el QR):');
    console.log(`  ${cdr.qrUrl}`);
    const { pdf, fileName } = await client.downloadDespatchPdf(cdr.qrUrl);
    mkdirSync('out', { recursive: true });
    const target = `out/${fileName ?? `${baseName}-PDF.pdf`}`;
    writeFileSync(target, pdf);
    console.log(`\nPDF oficial de SUNAT guardado en ${target} (${pdf.length} bytes).`);
  }

  if (stage === 'negative') {
    const prepared = client.prepareDespatch(testDespatch(99_999_002));
    checkSchema(prepared);
    // El motivo 99 no existe en el catálogo 20: el SDK no lo permitiría, así que se cambia directo en el XML.
    // SUNAT no valida la firma de las GRE (verificado el 2026-11-01), por eso no hace falta volver a firmar.
    const tampered: PreparedDespatch = {
      ...prepared,
      signedXml: prepared.signedXml.replace('catalogo20">13</cbc:HandlingCode>', 'catalogo20">99</cbc:HandlingCode>'),
    };
    if (tampered.signedXml === prepared.signedXml) throw new Error('No se pudo alterar el XML de prueba.');
    console.log(`Enviando ${prepared.baseName} con motivo de traslado inválido (99) a producción (debe ser rechazada)…`);
    const result = await client.sendDespatch(tampered);
    describe(result);
    if (result.status === 'rejected') console.log('Correcto: SUNAT la rechazó por una regla de negocio. La etapa de envío y lectura de errores funciona.');
    else console.log(`\n¡ATENCIÓN! SUNAT NO la rechazó. Si quedó aceptada, dala de baja en SOL (traslado no iniciado): ${prepared.baseName}`);
  }

  if (stage === 'positive') {
    const number = Number(optional('GRE_TEST_NUMBER', '1'));
    const prepared = client.prepareDespatch(testDespatch(number));
    show(prepared);
    checkSchema(prepared);
    console.log('\nESTO CREA UNA GUÍA REAL EN SUNAT (se puede dar de baja en SOL mientras el traslado no inicie).');
    // La confirmación es el texto exacto `ENVIAR <nombre>`: se escribe en la terminal o, si la terminal no es
    // interactiva (p. ej. el prefijo `!` de Claude Code), se pasa en GRE_CONFIRM="ENVIAR <nombre>".
    let answer = process.env.GRE_CONFIRM ?? '';
    if (!answer) {
      if (!process.stdin.isTTY) {
        console.log(`\nEsta terminal no es interactiva, así que no puedo pedirte la confirmación. Nada se envió.`);
        console.log(`Vuelve a correrlo con:  GRE_CONFIRM="ENVIAR ${prepared.baseName}" pnpm tsx --env-file=.env scripts/gre-prod-check.ts positive`);
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
    // Con downloadPdf el SDK intenta bajar el PDF oficial al emitir; si falla, la guía igual queda aceptada.
    const result = await client.sendDespatch(prepared, { downloadPdf: true });
    describe(result);
    if (result.status === 'accepted' || result.status === 'accepted_with_observations') {
      mkdirSync('out', { recursive: true });
      if (result.pdf) {
        const pdfPath = `out/${result.pdf.fileName ?? `${prepared.baseName}-PDF.pdf`}`;
        writeFileSync(pdfPath, result.pdf.pdf);
        console.log(`PDF oficial guardado en ${pdfPath}.`);
      } else if (result.pdfError) {
        console.log(`No se pudo bajar el PDF ahora (${result.pdfError.message}). La guía quedó aceptada; usa la etapa pdf más tarde.`);
      }
      writeFileSync(`out/${prepared.baseName}.xml`, prepared.signedXml);
      writeFileSync(`out/R-${prepared.baseName}.zip`, result.cdrZip);
      const xml = unzipFiles(result.cdrZip);
      console.log(`\nGuardados en out/: XML firmado y CDR (${Object.keys(xml).join(', ')}).`);
      if (result.cdr.qrUrl) console.log(`URL del QR (PDF oficial): ${result.cdr.qrUrl}\n(para descargarlo: etapa pdf)`);
      console.log(`Para limpiar: dar de baja ${prepared.baseName} en SOL (Empresas → Guía de Remisión Electrónica → Baja de GRE).`);
    }
  }
} catch (error) {
  printError(error);
}
