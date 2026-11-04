import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SunatApiError, SunatValidationError } from '../src';
import { consultRuc, type RucConsultResult } from '../src/ruc-consult';
import { CHALLENGE_CODE } from '../src/ruc-consult/api';
import { parseRucPage, RucPageError } from '../src/ruc-consult/parse';

/** RUC real y público usado en la lógica de referencia (EMPRESA DE TRANSPORTES PERU BUS KLEY S.A.C.). */
const RUC = '20539579356';
const LEGAL_NAME = 'EMPRESA DE TRANSPORTES PERU BUS KLEY S.A.C.';

type Reply = {
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
  body?: string;
  bytes?: Uint8Array;
  fail?: unknown;
};

/** Fetch simulado que responde en orden y registra URL, headers y campos del formulario de cada llamada. */
function mockFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit; fields: Record<string, string> }> = [];
  let step = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const next = replies[step];
    step += 1;
    if (!next) throw new Error(`Llamada n.º ${step} inesperada a ${String(url)}`);
    calls.push({
      url: String(url),
      init: init ?? {},
      fields: Object.fromEntries(new URLSearchParams(String(init?.body))),
    });
    if (next.fail !== undefined) throw next.fail;
    return new Response(next.bytes ?? next.body ?? '', {
      status: next.status ?? 200,
      headers: { 'content-type': next.contentType ?? 'text/html; charset=iso-8859-1', ...(next.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fn, calls, step: () => step };
}

const fieldRow = (label: string, value: string): string =>
  `<div class="row"><div class="col-sm-5"><h4 class="list-group-item-heading">${label}:</h4></div>` +
  `<div class="col-sm-7"><p class="list-group-item-text">${value}</p></div></div>`;

/** Página de resultado con la estructura REAL de SUNAT (bootstrap de list-group, revisada 04/11/2026). */
function resultsPage(
  ruc: string,
  legalName: string,
  fields: { tradeName?: string; status?: string; condition?: string; address?: string; activities?: string[] } = {},
): string {
  const activities = (fields.activities ?? [])
    .map((activity, n) => `<tr><td>${n === 0 ? `Principal - ${activity}` : `Secundaria ${n} - ${activity}`}</td></tr>`)
    .join('');
  return (
    '<!DOCTYPE html><html lang="es"><head><meta charset="iso-8859-1"><title>Resultado de la Búsqueda</title></head><body>' +
    '<div class="list-group">' +
    `<div class="list-group-item"><div class="row"><div class="col-sm-5"><h4 class="list-group-item-heading">N&uacute;mero de RUC:</h4></div>` +
    `<div class="col-sm-7"><h4 class="list-group-item-heading">${ruc} - ${legalName}</h4></div></div></div>` +
    `<div class="list-group-item"><div class="row"><div class="col-sm-3"><h4 class="list-group-item-heading">Tipo Contribuyente:</h4></div>` +
    `<div class="col-sm-3"><p class="list-group-item-text">SOCIEDAD ANONIMA CERRADA</p></div></div></div>` +
    (fields.tradeName === undefined ? '' : fieldRow('Nombre Comercial', fields.tradeName)) +
    (fields.status === undefined ? '' : fieldRow('Estado del Contribuyente', fields.status)) +
    (fields.condition === undefined ? '' : fieldRow('Condici&oacute;n del Contribuyente', fields.condition)) +
    (fields.address ? fieldRow('Domicilio Fiscal', fields.address) : '') +
    '</div>' +
    '<div class="list-group-item"><div class="row"><div class="col-sm-5"><h4 class="list-group-item-heading">Actividad(es) Econ&oacute;mica(s):</h4></div>' +
    `<div class="col-sm-7"><table class="table tblResultado"><tbody>${activities}</tbody></table></div></div></div>` +
    '</body></html>'
  );
}

/** Página que SUNAT muestra cuando la consulta se procesa sin resultados. */
const notFoundPage = (): string =>
  '<!DOCTYPE html><html lang="es"><head><title>Resultado de la Búsqueda</title></head><body>' +
  '<div class="content"><p>No se encontr&oacute; informaci&oacute;n para la b&uacute;squeda.</p></div></body></html>';

/** Página del desafío anti-bot que puede responder SUNAT en este dominio. */
const challengePage = (): string =>
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body></body></html>';

/** Los datos de un resultado `found`; si llega otro estado, el test falla con un mensaje claro. */
function found(result: RucConsultResult) {
  if (result.status !== 'found') throw new Error(`se esperaba status 'found' y llegó '${result.status}'`);
  return result;
}

describe('consultRuc (página simulada)', () => {
  it('interpreta la página REAL capturada de SUNAT (fixture de calibración)', () => {
    const page = readFileSync(new URL('./fixtures/ruc-consult-20539579356.html', import.meta.url), 'utf8');
    expect(parseRucPage(page, '20539579356')).toEqual({
      status: 'found',
      ruc: '20539579356',
      legalName: 'EMPRESA DE TRANSPORTES PERU BUS KLEY S.A.C.',
      tradeName: 'PERU BUS KLEY',
      taxpayerStatus: 'ACTIVO',
      taxpayerCondition: 'HABIDO',
      fiscalAddress:
        'OTR.CIUDAD MAJES MZA. O-5 LOTE. 18 H.U. MOD. A SECTOR 3 (OVALO DE CIUDAD MAJES) AREQUIPA - CAYLLOMA - MAJES',
      mainActivity: { code: '4922', description: 'OTRAS ACTIVIDADES DE TRANSPORTE POR VÍA TERRESTRE' },
    });
  });

  it('consulta con el mismo formulario que la web y devuelve los datos publicados', async () => {
    const mock = mockFetch([
      {
        body: resultsPage(RUC, LEGAL_NAME, {
          tradeName: 'PERU BUS KLEY',
          status: 'ACTIVO',
          condition: 'HABIDO',
          address: 'AV. FERROCARRIL NRO. 1235 LIMA - LIMA - LIMA',
          activities: ['4921 - TRANSPORTE MUNICIPAL DE PASAJEROS', '0130 - CULTIVO DE TRIGO'],
        }),
      },
    ]);
    const result = await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 } });

    expect(result).toEqual({
      status: 'found',
      ruc: RUC,
      legalName: LEGAL_NAME,
      tradeName: 'PERU BUS KLEY',
      taxpayerStatus: 'ACTIVO',
      taxpayerCondition: 'HABIDO',
      fiscalAddress: 'AV. FERROCARRIL NRO. 1235 LIMA - LIMA - LIMA',
      mainActivity: { code: '4921', description: 'TRANSPORTE MUNICIPAL DE PASAJEROS' },
    });

    const { url, init, fields } = mock.calls[0]!;
    expect(url).toBe('https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/jcrS00Alias');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers.Referer).toBe('https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/FrameCriterioBusquedaWeb.jsp');
    expect(headers['User-Agent']).toContain('Chrome/130');
    expect(headers['Accept-Language']).toBe('es-ES,es;q=0.9');
    expect(fields).toEqual({
      accion: 'consPorRuc',
      razSoc: '',
      nroRuc: RUC,
      nrodoc: '',
      token: expect.stringMatching(/^[a-z0-9]{52}$/),
      contexto: 'ti-it',
      modo: '1',
      rbtnTipo: '1',
      search1: RUC,
      tipdoc: '1',
      search2: '',
      search3: '',
      codigo: '',
    });
  });

  it('saca la razón social del "RUC - razón social" del h4, ignora las actividades secundarias', async () => {
    const mock = mockFetch([
      {
        body: resultsPage(RUC, LEGAL_NAME, {
          activities: [
            '4921 - TRANSPORTE PRIVADO DE CARGA (DESDE UN INCISO A LA PROVINCIA)',
            '5238 - VENTA POR CORREO',
          ],
        }),
      },
    ]);
    const result = await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 } });
    expect(found(result).legalName).toBe('EMPRESA DE TRANSPORTES PERU BUS KLEY S.A.C.');
    expect(found(result).mainActivity).toEqual({
      code: '4921',
      description: 'TRANSPORTE PRIVADO DE CARGA (DESDE UN INCISO A LA PROVINCIA)',
    });
  });

  it('una actividad sin código y los campos vacíos quedan como no informados', async () => {
    const mock = mockFetch([
      {
        body: resultsPage(RUC, 'CONTRIBUYENTE SIN ACTIVIDAD ECONOMICA S.A.', {
          tradeName: '-',
          status: 'ACTIVO',
          condition: 'NO HABIDO',
        }),
      },
    ]);
    const result = await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 } });
    expect(result).toEqual({
      status: 'found',
      ruc: RUC,
      legalName: 'CONTRIBUYENTE SIN ACTIVIDAD ECONOMICA S.A.',
      taxpayerStatus: 'ACTIVO',
      taxpayerCondition: 'NO HABIDO',
    });
  });

  it('devuelve not_found cuando SUNAT procesa la consulta y no informa datos', async () => {
    const mock = mockFetch([{ body: notFoundPage() }]);
    expect(await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 } })).toEqual({ status: 'not_found', ruc: RUC });
    expect(mock.step()).toBe(1); // "no encontrado" es un resultado: no se reintenta
  });

  it('valida el RUC antes de consultar y no toca la red', async () => {
    const mock = mockFetch([]);
    for (const invalid of ['12345678901', '20131312954', '2053957935', 'abc123']) {
      await expect(consultRuc(invalid, { fetch: mock.fn })).rejects.toBeInstanceOf(SunatValidationError);
    }
    expect(mock.fn).not.toHaveBeenCalled();
  });

  it('recorta los espacios del RUC antes de usarlo', async () => {
    const mock = mockFetch([{ body: notFoundPage() }]);
    expect(await consultRuc(`  ${RUC}  `, { fetch: mock.fn, retry: { delayMs: 0 } })).toEqual({
      status: 'not_found',
      ruc: RUC,
    });
    expect(mock.calls[0]!.fields.nroRuc).toBe(RUC);
  });

  it('fusiona las cabeceras propias (cookies de navegador) sobre las por defecto', async () => {
    const mock = mockFetch([{ body: resultsPage(RUC, LEGAL_NAME) }]);
    await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 }, headers: { Cookie: 'cf_clearance=abc123;' } });
    const headers = mock.calls[0]!.init.headers as Record<string, string>;
    expect(headers.Cookie).toBe('cf_clearance=abc123;');
    expect(headers.Referer).toBe('https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/FrameCriterioBusquedaWeb.jsp'); // las por defecto siguen
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('un desafío anti-bot de Cloudflare avisa claramente y no se reintenta', async () => {
    const mock = mockFetch([{ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: challengePage() }]);
    const error = await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatApiError);
    expect((error as SunatApiError).code).toBe(CHALLENGE_CODE);
    expect((error as SunatApiError).status).toBe(403);
    expect((error as SunatApiError).message).toContain('desafío anti-bot');
    expect((error as SunatApiError).rawBody).toContain('Just a moment');
    expect(mock.step()).toBe(1);
  });

  it('el desafío no cae en el fallback de curl si el que llama desactiva curlFallback', async () => {
    const mock = mockFetch([{ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: challengePage() }]);
    const error = await consultRuc(RUC, { fetch: mock.fn, curlFallback: false, retry: { delayMs: 0 } }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SunatApiError);
    expect((error as SunatApiError).code).toBe(CHALLENGE_CODE);
    expect(mock.step()).toBe(1);
  });

  it('decodifica la página en windows-1252 (latin-1) aunque no declare charset', async () => {
    // bytes con tildes crudas ("Ñ" = 0xD1, "ú" = 0xFA, como las que SUNAT responde sin charset explícito)
    const raw =
      '<html lang="es"><head><title>Resultado de la Búsqueda</title></head><body>' +
      `<h4>Número de RUC:</h4><h4>${RUC} - ACEROS PE\u00D1A CABALLERO S.A.C.</h4>` +
      `<div class="row"><div class="col-sm-5"><h4>Nombre Comercial:</h4></div>` +
      `<div class="col-sm-7"><p>ACEROS PE\u00D1A</p></div></div></body></html>`;
    const mock = mockFetch([{ bytes: new Uint8Array(Buffer.from(raw, 'latin1')), contentType: 'text/html' }]);
    const result = await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 } });
    expect(found(result).legalName).toBe('ACEROS PE\u00D1A CABALLERO S.A.C.');
    expect(found(result).tradeName).toBe('ACEROS PE\u00D1A');
  });

  describe('fallos y reintentos', () => {
    const validPage = resultsPage(RUC, LEGAL_NAME);

    it('reintenta un corte de red y una página que no se puede interpretar', async () => {
      const mock = mockFetch([
        { fail: new TypeError('fetch failed') },
        { body: '<html>SUNAT en mantenimiento</html>' },
        { body: validPage },
      ]);
      const result = await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 } });
      expect(found(result).legalName).toBe(LEGAL_NAME);
      expect(mock.step()).toBe(3);
    });

    it('reintenta un HTTP 5xx (es una lectura sin efecto)', async () => {
      const mock = mockFetch([{ status: 503, body: '<html>503</html>' }, { body: validPage }]);
      const result = await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 } });
      expect(found(result).legalName).toBe(LEGAL_NAME);
      expect(mock.step()).toBe(2);
    });

    it('no reintenta un HTTP 404', async () => {
      const mock = mockFetch([{ status: 404, body: '<html>404</html>' }]);
      const error = await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 } }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SunatApiError);
      expect((error as SunatApiError).status).toBe(404);
      expect(mock.step()).toBe(1);
    });

    it('agota los reintentos cuando SUNAT responde páginas que no son un resultado', async () => {
      const mock = mockFetch([
        { body: '<html>Servicio no disponible</html>' },
        { body: '<html>Servicio no disponible</html>' },
        { body: '<html>Servicio no disponible</html>' },
        { body: '<html>Servicio no disponible</html>' },
      ]);
      const error = await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 } }).catch((e: unknown) => e); // 1 intento + 3 reintentos por defecto
      expect(error).toBeInstanceOf(RucPageError);
      expect(error).not.toBeInstanceOf(SunatApiError); // no se mezcla con los códigos de SUNAT
      expect((error as RucPageError).retryable).toBe(true);
      expect((error as RucPageError).rawBody).toContain('Servicio no disponible');
      expect(mock.step()).toBe(4);
    });

    it('rechaza si SUNAT responde por otro RUC (y reintenta antes de rendirse)', async () => {
      const otherRucPage = resultsPage('20131312955', 'OTRA EMPRESA SOCIEDAD ANONIMA CERRADA');
      const mock = mockFetch([
        { body: otherRucPage },
        { body: otherRucPage },
        { body: otherRucPage },
        { body: otherRucPage },
      ]);
      const error = await consultRuc(RUC, { fetch: mock.fn, retry: { delayMs: 0 } }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RucPageError);
      expect((error as RucPageError).message).toContain('20131312955');
      expect(mock.step()).toBe(4); // 1 intento + 3 reintentos por defecto
    });
  });
});
