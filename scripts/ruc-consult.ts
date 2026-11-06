/**
 * Consulta real (solo lectura, sin credenciales) de los datos que SUNAT publica de uno o varios RUC.
 *
 *   pnpm tsx scripts/ruc-consult.ts 20539579356 [más RUC...] [--dump]
 *
 * Usa `consultRuc`, el mismo servicio público del formulario de e-consultaruc.sunat.gob.pe que usa el SDK.
 * Con `--dump` guarda en `out/` el HTML que SUNAT devolvió: sirve para revisar qué campos publicó y calibrar
 * los patrones de `src/ruc-consult/parse.ts` cuando SUNAT cambie su página.
 *
 * Al 04/11/2026 el dominio está detrás de un desafío anti-bot de Cloudflare que desafía el TLS de Node;
 * `consultRuc` reintenta solo, con el curl del sistema (fallback automático, `curlFallback: true` por defecto).
 * Si tu entorno tampoco lo consigue con curl, abre el formulario en tu navegador (misma IP), copia la cookie
 * `cf_clearance` y tu `User-Agent` (DevTools → Red → petición a jcrS00Alias) y pásalos al SDK con
 * `consultRuc(ruc, { headers: { Cookie: 'cf_clearance=…', 'User-Agent': '…' } })` (ver RucConsultOptions.headers).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SunatApiError, SunatValidationError } from '../src';
import { consultRuc } from '../src/ruc-consult';
import { CHALLENGE_CODE } from '../src/ruc-consult/api';

const args = process.argv.slice(2);
const dump = args.includes('--dump');
const rucs = args.filter((arg) => !arg.startsWith('--')).map((arg) => arg.trim());

if (rucs.length === 0) {
  console.error('Indica al menos un RUC: pnpm tsx scripts/ruc-consult.ts 20539579356 [--dump]');
  process.exit(2);
}

if (dump) await mkdir('out', { recursive: true });

for (const ruc of rucs) {
  let page: string | undefined;
  try {
    const data = await consultRuc(ruc, {
      ...(dump
        ? {
            onPage: (html: string) => {
              page = html;
            },
          }
        : {}),
    });
    if (page && dump) await writeFile(join('out', `ruc-consult-${data.ruc}.html`), page, 'utf8');

    if (data.status === 'not_found') {
      console.log(`${ruc}: sin datos — SUNAT no informa (puede ser cierto o SUNAT saturada; reintenta más tarde).`);
      continue;
    }
    console.log(`${data.ruc}:`);
    console.log(`  Razón social: ${data.legalName}`);
    if (data.tradeName) console.log(`  Nombre comercial: ${data.tradeName}`);
    if (data.taxpayerStatus) console.log(`  Estado del contribuyente: ${data.taxpayerStatus}`);
    if (data.taxpayerCondition) console.log(`  Condición del contribuyente: ${data.taxpayerCondition}`);
    if (data.fiscalAddress) console.log(`  Domicilio fiscal: ${data.fiscalAddress}`);
    if (data.mainActivity) {
      const { code, description } = data.mainActivity;
      console.log(`  Actividad económica principal: ${code ? `${code} - ` : ''}${description}`);
    }
  } catch (error) {
    if (error instanceof SunatApiError && error.code === CHALLENGE_CODE) {
      console.error(`${ruc}: la consulta cayó en el desafío anti-bot de SUNAT (Cloudflare); no se consultó nada.`);
      console.error('  Abre e-consultaruc en tu navegador (misma IP), copia la cookie `cf_clearance` y tu User-Agent');
      console.error('  (DevTools → Red → petición a jcrS00Alias) y pásalos con consultRuc(ruc, { headers: {...} }).');
    } else if (error instanceof SunatValidationError) {
      console.error(`${ruc}: RUC inválido (revisa los 11 dígitos y el dígito verificador); no se consultó a SUNAT.`);
    } else {
      console.error(`${ruc}: error — ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}
