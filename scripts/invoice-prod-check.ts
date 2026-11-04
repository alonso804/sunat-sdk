/**
 * Verificación de facturas contra PRODUCCIÓN, SOLO LECTURA. No envía ni crea ningún comprobante.
 *
 *   pnpm tsx --env-file=.env scripts/invoice-prod-check.ts [serie] [número]
 *
 * Consulta con `getStatusCdr` (servicio de consulta de SUNAT) el estado de un comprobante. Por defecto pregunta
 * por F001-99999999, que casi seguro no existe: lo que interesa no es el resultado de la consulta sino comprobar
 * que el usuario SOL secundario, su clave y su permiso funcionan en producción.
 *
 * Cómo leer el resultado:
 *   - Un código/mensaje de SUNAT (p. ej. "comprobante no existe"): la autenticación y el permiso funcionan.
 *   - Un SOAP Fault por usuario/clave/perfil (p. ej. 0111, 0102, 0103): revisa SUNAT_SOL_USER/PASSWORD y los permisos
 *     del usuario secundario en SOL (Modificar Programas).
 *   - Un fallo de red: SUNAT no respondió; reintenta más tarde, sin insistir en ráfagas.
 * Las variables de entorno son las mismas del resto de scripts (ver .env.example). No se imprimen secretos.
 */
import { readFileSync } from 'node:fs';
import { SunatClient, SunatFaultError, SunatTransportError, SunatValidationError, signingKeyFromPfx } from '../src';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta la variable de entorno ${name}. Revisa .env.example.`);
    process.exit(2);
  }
  return value;
};

const series = process.argv[2] ?? 'F001';
const number = Number(process.argv[3] ?? '99999999');

const client = new SunatClient({
  environment: 'production',
  issuer: {
    ruc: need('SUNAT_RUC'),
    legalName: need('SUNAT_LEGAL_NAME'),
    address: {
      ubigeo: need('SUNAT_UBIGEO'),
      department: need('SUNAT_DEPARTMENT'),
      province: need('SUNAT_PROVINCE'),
      district: need('SUNAT_DISTRICT'),
      street: need('SUNAT_ADDRESS'),
    },
  },
  sol: { user: need('SUNAT_SOL_USER'), password: need('SUNAT_SOL_PASSWORD') },
  signingKey: signingKeyFromPfx(readFileSync(need('SUNAT_CERT_PATH')), need('SUNAT_CERT_PASSWORD')),
});

console.log(`Consultando en PRODUCCIÓN (solo lectura) el estado de ${series}-${number}…`);
try {
  const result = await client.getInvoiceStatus({ series, number });
  console.log(`\nSUNAT respondió: código=${result.statusCode}  mensaje=${result.statusMessage}`);
  if (result.cdr) console.log(`CDR adjunto: ${result.cdr.referenceId} → ${result.cdr.description}`);
  if (result.statusCode === '0127')
    console.log(
      '(0127 "El ticket no existe": es lo que SUNAT respondió el 2026-11-01 para un comprobante que no existe.)',
    );
  console.log(
    '\nSUNAT aceptó el usuario, la clave y el permiso de CONSULTA (si fallaran, habría respondido con una excepción).',
  );
  console.log('El permiso de ENVÍO (sendBill) no se puede comprobar sin enviar un comprobante real.');
} catch (error) {
  if (error instanceof SunatFaultError) {
    console.error(`\nSUNAT respondió con una excepción ${error.code}: ${error.sunatMessage}`);
    console.error(
      'Si habla de usuario, clave o perfil, revisa SUNAT_SOL_USER/PASSWORD y los permisos del usuario en SOL.',
    );
  } else if (error instanceof SunatTransportError) console.error(`\nError de red: ${error.message}`);
  else if (error instanceof SunatValidationError)
    console.error(`\nDatos inválidos (no se contactó a SUNAT): ${error.message}`);
  else console.error('\nError inesperado:', error);
  process.exit(1);
}
