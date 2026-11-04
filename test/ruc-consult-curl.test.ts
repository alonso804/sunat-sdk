import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { curlFetch, isCurlAvailable } from '../src/ruc-consult';
import { parseRucPage } from '../src/ruc-consult/parse';

/** RUC real y público usado en la lógica de referencia. */
const RUC = '20539579356';
const LEGAL_NAME = 'EMPRESA DE TRANSPORTES PERU BUS KLEY S.A.C.';

const hasCurl = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--version']).status === 0;

function resultsPage(): string {
  return (
    '<html lang="es"><head><title>Resultado de la Búsqueda</title></head><body>' +
    '<div class="row"><div class="col-sm-5"><h4 class="list-group-item-heading">N&uacute;mero de RUC:</h4></div>' +
    `<div class="col-sm-7"><h4 class="list-group-item-heading">${RUC} - ${LEGAL_NAME}</h4></div></div>` +
    '<div class="row"><div class="col-sm-5"><h4 class="list-group-item-heading">Nombre Comercial:</h4></div>' +
    '<div class="col-sm-7"><p class="list-group-item-text">PERU BUS KLEY</p></div></div>' +
    '<div class="list-group-item"><div class="row"><div class="col-sm-5"><h4 class="list-group-item-heading">Actividad(es) Econ&oacute;mica(s):</h4></div>' +
    '<div class="col-sm-7"><table><tbody><tr><td>Principal - 4922 - OTRAS ACTIVIDADES DE TRANSPORTE POR VÍA TERRESTRE</td></tr></tbody></table></div></div></div>' +
    '</body></html>'
  );
}

describe('curlFetch (transporte con curl del sistema, sin red)', () => {
  let server: Server;
  let baseUrl: string;
  let seen: Array<{ method?: string; headers: IncomingHttpHeaders; body: string }>;
  let reply: { status: number; headers: Array<[string, string]>; body: Buffer };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(reply.status, Object.fromEntries(reply.headers));
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    seen = [];
    reply = { status: 200, headers: [['Content-Type', 'text/html; charset=iso-8859-1']], body: Buffer.from(resultsPage(), 'latin1') };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.skipIf(!hasCurl)('envía el encargo con sus cabeceras y entrega la respuesta en bytes (charset preservado)', async () => {
    const response = await curlFetch()(baseUrl, {
      method: 'POST',
      headers: { 'User-Agent': 'UA DE PRUEBA', Referer: 'https://ejemplo.local/formulario.jsp', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `accion=consPorRuc&nroRuc=${RUC}`,
      signal: AbortSignal.timeout(15_000),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=iso-8859-1');
    // el cuerpo llega como bytes, listo para decodificarse con el charset del Content-Type
    const text = new TextDecoder('windows-1252').decode(new Uint8Array(await response.arrayBuffer()));
    expect(parseRucPage(text, RUC)).toEqual({
      status: 'found',
      ruc: RUC,
      legalName: LEGAL_NAME,
      tradeName: 'PERU BUS KLEY',
      mainActivity: { code: '4922', description: 'OTRAS ACTIVIDADES DE TRANSPORTE POR VÍA TERRESTRE' },
    });

    const sent = seen[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(sent.body).toBe(`accion=consPorRuc&nroRuc=${RUC}`);
    expect(sent.headers.referer).toBe('https://ejemplo.local/formulario.jsp');
    expect(sent.headers['user-agent']).toBe('UA DE PRUEBA');
  });

  it.skipIf(!hasCurl)('expone la respuesta del desafío anti-bot con sus cabeceras', async () => {
    reply = {
      status: 403,
      headers: [['Content-Type', 'text/html; charset=UTF-8'], ['cf-mitigated', 'challenge']],
      body: Buffer.from('<html><head><title>Just a moment...</title></head></html>', 'utf8'),
    };
    const response = await curlFetch()(baseUrl, { method: 'POST', body: 'a=1' });
    expect(response.status).toBe(403);
    expect(response.headers.get('cf-mitigated')).toBe('challenge');
    expect(await response.text()).toContain('Just a moment');
  });

  it.skipIf(!hasCurl)('detecta un curl del sistema disponible (base del fallback automático)', () => {
    expect(isCurlAvailable()).toBe(true);
  });
});
