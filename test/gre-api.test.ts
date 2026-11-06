import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { SunatApiError, SunatClient, SunatError, SunatTransportError, SunatValidationError } from '../src';
import { unzipFiles } from '../src/zip';
import { cdrXml, cdrZipBase64, sampleDespatch, TEST_ISSUER, TEST_RUC, testCertificate } from './helpers';

const BASE = `${TEST_RUC}-09-T001-1`;
const { key } = testCertificate();

type Reply = { status?: number; body: unknown };
const json = ({ status = 200, body }: Reply) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fetch simulado que responde en orden y registra cada llamada. */
function mockFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...replies];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error(`Llamada inesperada a ${String(url)}`);
    return json(next);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const TOKEN: Reply = { body: { access_token: 'TOKEN-1', token_type: 'Bearer', expires_in: 3600 } };
const SENT: Reply = { body: { numTicket: 'ticket-uuid-1', fecRecepcion: '2026-10-31T15:30:01.000-05:00' } };
const accepted = (notes: string[] = []): Reply => ({
  body: {
    codRespuesta: '0',
    indCdrGenerado: '1',
    arcCdr: cdrZipBase64(
      BASE,
      cdrXml({ reference: 'T001-1', code: '0', description: 'La Guia numero T001-1, ha sido aceptada', notes }),
    ),
  },
});

function makeClient(replies: Reply[], options: { now?: () => Date } = {}) {
  const mock = mockFetch(replies);
  const client = new SunatClient({
    environment: 'production',
    issuer: TEST_ISSUER,
    sol: { user: 'USUARIO1', password: 'clave-sol' },
    gre: { clientId: 'cid-123', clientSecret: 'secret-456' },
    signingKey: key,
    fetch: mock.fn,
    now: options.now ?? (() => new Date('2026-10-31T15:30:00-05:00')),
    retry: { delayMs: 0 },
  });
  return { client, ...mock };
}

const fastPolling = { pollIntervalMs: 1, sleep: async () => {} };

describe('SunatClient.sendDespatch (API REST simulada)', () => {
  it('autentica, envía el ZIP con su hash y devuelve la guía aceptada', async () => {
    const { client, calls } = makeClient([TOKEN, SENT, accepted()]);
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling);

    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') {
      expect(result.ticket).toBe('ticket-uuid-1');
      expect(result.cdr.accepted).toBe(true);
    }

    // 1) token OAuth2 (password grant) con RUC + usuario SOL
    const [tokenCall, sendCall, statusCall] = calls;
    expect(tokenCall?.url).toBe('https://api-seguridad.sunat.gob.pe/v1/clientessol/cid-123/oauth2/token/');
    expect(tokenCall?.init.method).toBe('POST');
    const form = new URLSearchParams(String(tokenCall?.init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'password',
      scope: 'https://api-cpe.sunat.gob.pe',
      client_id: 'cid-123',
      client_secret: 'secret-456',
      username: `${TEST_RUC}USUARIO1`,
      password: 'clave-sol',
    });

    // 2) envío: nombre sin extensión en la ruta, Bearer y cuerpo con ZIP + SHA-256
    expect(sendCall?.url).toBe(`https://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes/${BASE}`);
    expect((sendCall!.init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN-1');
    const body = JSON.parse(String(sendCall?.init.body)) as {
      archivo: { nomArchivo: string; arcGreZip: string; hashZip: string };
    };
    expect(body.archivo.nomArchivo).toBe(`${BASE}.zip`);
    const zip = new Uint8Array(Buffer.from(body.archivo.arcGreZip, 'base64'));
    expect(body.archivo.hashZip).toBe(createHash('sha256').update(zip).digest('hex'));
    const files = unzipFiles(zip);
    expect(Object.keys(files)).toEqual([`${BASE}.xml`]);
    expect(Buffer.from(files[`${BASE}.xml`] as Uint8Array).toString('utf8')).toContain('<DespatchAdvice');

    // 3) consulta del ticket
    expect(statusCall?.url).toBe('https://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes/envios/ticket-uuid-1');
    expect(statusCall?.init.method).toBe('GET');
  });

  it('sigue consultando mientras SUNAT responde 98 (en proceso)', async () => {
    const sleep = vi.fn(async () => {});
    const { client, calls } = makeClient([
      TOKEN,
      SENT,
      { body: { codRespuesta: '98' } },
      { body: { codRespuesta: '98' } },
      accepted(),
    ]);
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), { pollIntervalMs: 5, sleep });
    expect(result.status).toBe('accepted');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(5);
  });

  it('devuelve pending si se agota la espera y permite consultar después', async () => {
    let clock = 0;
    const { client } = makeClient([
      TOKEN,
      SENT,
      { body: { codRespuesta: '98' } },
      { body: { codRespuesta: '98' } },
      accepted(),
    ]);
    const pending = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), {
      pollIntervalMs: 1000,
      maxWaitMs: 500, // tras el primer sondeo (t=0) duerme 1000 ms; el segundo (t=1000) ya excede la espera
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(pending.status).toBe('pending');

    const later = await client.getDespatchStatus({ baseName: BASE, ticket: 'ticket-uuid-1' });
    expect(later.status).toBe('accepted');
  });

  describe('fallos al consultar el ticket (SUNAT ya recibió la guía)', () => {
    /** Fetch que responde token y envío, y luego aplica `poll` a cada consulta del ticket. */
    function pollingClient(poll: (n: number) => Response) {
      let polls = 0;
      const fn = vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/oauth2/token')) return json(TOKEN);
        if (u.includes('/envios/')) return poll(++polls);
        if (u.includes('/gem/comprobantes/')) return json(SENT);
        throw new Error(`Llamada inesperada a ${u}`);
      }) as unknown as typeof fetch;
      const client = new SunatClient({
        environment: 'production',
        issuer: TEST_ISSUER,
        sol: { user: 'USUARIO1', password: 'clave-sol' },
        gre: { clientId: 'cid-123', clientSecret: 'secret-456' },
        signingKey: key,
        fetch: fn,
        now: () => new Date('2026-10-31T15:30:00-05:00'),
        retry: { delayMs: 0 },
      });
      return { client, polls: () => polls };
    }

    /** Reloj simulado: cada pausa avanza el tiempo, para que la espera se agote. */
    function clockOptions(maxWaitMs: number) {
      let clock = 0;
      return {
        pollIntervalMs: 1000,
        maxWaitMs,
        sleep: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
      };
    }

    it('un corte de red persistente devuelve pending con el ticket (no lanza)', async () => {
      const { client, polls } = pollingClient(() => {
        throw new TypeError('fetch failed');
      });
      const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), clockOptions(2500));
      expect(result).toMatchObject({ status: 'pending', baseName: BASE, ticket: 'ticket-uuid-1' });
      expect(result.status === 'pending' && result.statusError).toBeInstanceOf(SunatTransportError);
      expect(polls()).toBe(4); // t = 0, 1000, 2000, 3000: reintenta mientras dura la espera
    });

    it('un fallo pasajero (red o 5xx) se reintenta y la guía termina aceptada', async () => {
      const { client } = pollingClient((n) => {
        if (n === 1) throw new TypeError('fetch failed');
        if (n === 2) return json({ status: 503, body: { cod: '503', msg: 'Service Unavailable' } });
        return json(accepted());
      });
      const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), clockOptions(60_000));
      expect(result.status).toBe('accepted');
    });

    it('un error no pasajero (respuesta desconocida) devuelve pending con el ticket sin seguir consultando', async () => {
      const { client, polls } = pollingClient(() => json({ body: { codRespuesta: '77' } }));
      const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), clockOptions(60_000));
      expect(result).toMatchObject({ status: 'pending', ticket: 'ticket-uuid-1' });
      expect(result.status === 'pending' && result.statusError).toBeInstanceOf(SunatApiError);
      expect(polls()).toBe(1);
    });

    it('getDespatchStatus reintenta y, si el fallo persiste, lanza (quien llama ya tiene el ticket)', async () => {
      const { client, polls } = pollingClient(() => {
        throw new TypeError('fetch failed');
      });
      await expect(client.getDespatchStatus({ baseName: BASE, ticket: 'ticket-uuid-1' })).rejects.toBeInstanceOf(
        SunatTransportError,
      );
      expect(polls()).toBe(4); // 1 intento + 3 reintentos
    });

    it('getDespatchStatus supera un fallo pasajero', async () => {
      const { client } = pollingClient((n) =>
        n === 1 ? json({ status: 502, body: { cod: '502', msg: 'Bad Gateway' } }) : json(accepted()),
      );
      expect((await client.getDespatchStatus({ baseName: BASE, ticket: 'ticket-uuid-1' })).status).toBe('accepted');
    });
  });

  it('informa las observaciones del CDR', async () => {
    const { client } = makeClient([TOKEN, SENT, accepted(['4000 - observación de prueba'])]);
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling);
    expect(result.status).toBe('accepted_with_observations');
    if (result.status === 'accepted_with_observations')
      expect(result.cdr.notes).toEqual(['4000 - observación de prueba']);
  });

  it('mapea el código 99 como rechazo con el detalle del error', async () => {
    const { client } = makeClient([
      TOKEN,
      SENT,
      {
        body: {
          codRespuesta: '99',
          indCdrGenerado: '0',
          error: { numError: '2755', desError: 'El documento tiene errores' },
        },
      },
    ]);
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling);
    expect(result).toMatchObject({
      status: 'rejected',
      code: '2755',
      message: 'El documento tiene errores',
      ticket: 'ticket-uuid-1',
    });
  });

  it('un CDR con código distinto de 0 es un rechazo', async () => {
    const reply: Reply = {
      body: {
        codRespuesta: '0',
        indCdrGenerado: '1',
        arcCdr: cdrZipBase64(BASE, cdrXml({ reference: 'T001-1', code: '2324', description: 'Rechazada' })),
      },
    };
    const { client } = makeClient([TOKEN, SENT, reply]);
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling);
    expect(result).toMatchObject({ status: 'rejected', code: '2324' });
  });

  it('reutiliza el token mientras no venza y lo renueva después', async () => {
    let now = new Date('2026-10-31T15:30:00-05:00').getTime();
    const second: Reply = { body: { access_token: 'TOKEN-2', token_type: 'Bearer', expires_in: 3600 } };
    const { client, calls } = makeClient([TOKEN, SENT, accepted(), SENT, accepted(), second, SENT, accepted()], {
      now: () => new Date(now),
    });

    await client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling);
    await client.sendDespatch(client.prepareDespatch(sampleDespatch({ number: 2 })), fastPolling);
    expect(calls.filter((c) => c.url.includes('oauth2/token')).length).toBe(1);

    now += 3_600_000; // pasa una hora: el token venció
    await client.sendDespatch(client.prepareDespatch(sampleDespatch({ number: 3 })), fastPolling);
    const tokenCalls = calls.filter((c) => c.url.includes('oauth2/token'));
    expect(tokenCalls.length).toBe(2);
    expect((calls[calls.length - 2]!.init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN-2');
  });

  it('si SUNAT rechaza el token en caché (401), renueva y reintenta una vez', async () => {
    const second: Reply = { body: { access_token: 'TOKEN-2', token_type: 'Bearer', expires_in: 3600 } };
    const { client, calls } = makeClient([
      TOKEN,
      SENT,
      accepted(), // primer envío: deja el token en caché
      { status: 401, body: { cod: '401', msg: 'Unauthorized' } }, // el token en caché ya no sirve
      second,
      SENT,
      accepted(),
    ]);
    await client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling);
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch({ number: 2 })), fastPolling);
    expect(result.status).toBe('accepted');
    expect(calls.filter((c) => c.url.includes('oauth2/token')).length).toBe(2);
  });

  it('un error de validación 422 se convierte en SunatApiError con detalle', async () => {
    const { client } = makeClient([
      TOKEN,
      {
        status: 422,
        body: {
          cod: '422',
          msg: 'Unprocessable Entity',
          errors: [{ codError: '1033', desError: 'El comprobante ya fue registrado' }],
        },
      },
    ]);
    const error = await client
      .sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatApiError);
    const api = error as SunatApiError;
    expect(api.status).toBe(422);
    expect(api.details).toEqual([{ code: '1033', message: 'El comprobante ya fue registrado' }]);
    expect(api.retryable).toBe(false);
  });

  it('credenciales de API incorrectas dan un error de autenticación claro', async () => {
    const { client } = makeClient([
      { status: 401, body: { error: 'invalid_client', error_description: 'Credenciales inválidas' } },
    ]);
    const error = await client
      .sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatApiError);
    expect((error as SunatApiError).isAuthError).toBe(true);
    expect((error as SunatApiError).message).toContain('Credenciales inválidas');
  });

  it('un 503 al enviar se reintenta (SUNAT no procesó la petición) y la guía queda aceptada', async () => {
    const UNAVAILABLE: Reply = { status: 503, body: { cod: '503', msg: 'Service Unavailable' } };
    const { client, calls } = makeClient([TOKEN, UNAVAILABLE, SENT, accepted()]);
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling);
    expect(result.status).toBe('accepted');
    expect(calls.filter((c) => c.init.method === 'POST' && c.url.includes('/gem/comprobantes/'))).toHaveLength(2);
  });

  it('un 503 persistente al enviar lanza SunatApiError reintentable, tras el tope de reintentos', async () => {
    const UNAVAILABLE: Reply = { status: 503, body: { cod: '503', msg: 'Service Unavailable' } };
    const { client, calls } = makeClient([TOKEN, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);
    const error = await client
      .sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatApiError);
    expect((error as SunatApiError).status).toBe(503);
    expect((error as SunatApiError).retryable).toBe(true);
    expect(calls).toHaveLength(5); // token + 1 envío + 3 reintentos
  });

  it('un 500 al enviar NO se reintenta: SUNAT pudo haber recibido la guía', async () => {
    const { client, calls } = makeClient([TOKEN, { status: 500, body: { cod: '500', msg: 'Internal Server Error' } }]);
    const error = await client
      .sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling)
      .catch((e: unknown) => e);
    expect((error as SunatApiError).status).toBe(500);
    expect(calls).toHaveLength(2);
  });

  it('lanza SunatTransportError si falla la red', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = new SunatClient({
      environment: 'production',
      issuer: TEST_ISSUER,
      sol: { user: 'USUARIO1', password: 'x' },
      gre: { clientId: 'a', clientSecret: 'b' },
      signingKey: key,
      fetch: failing,
      retry: { delayMs: 0 },
    });
    await expect(client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling)).rejects.toBeInstanceOf(
      SunatTransportError,
    );
    expect(failing).toHaveBeenCalledTimes(4); // el token (sin efecto) se reintenta; nunca se llegó a enviar la guía
  });

  it('pide configurar las credenciales de API si faltan', async () => {
    const client = new SunatClient({
      environment: 'production',
      issuer: TEST_ISSUER,
      sol: { user: 'U', password: 'x' },
      signingKey: key,
    });
    await expect(client.sendDespatch(client.prepareDespatch(sampleDespatch()))).rejects.toBeInstanceOf(
      SunatValidationError,
    );
  });
});

describe('secretos fuera de lo que se imprime o se serializa', () => {
  it('ni util.inspect (console.log) ni JSON.stringify del cliente muestran claves, llave privada ni token', async () => {
    const { client } = makeClient([TOKEN, SENT, accepted()]);
    await client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling); // deja el token en caché
    const printed = `${inspect(client, { depth: Number.POSITIVE_INFINITY, showHidden: true })}\n${JSON.stringify(client)}`;
    expect(printed).toContain(TEST_RUC); // el emisor sí se ve: la prueba mira el objeto real
    for (const secret of ['clave-sol', 'secret-456', 'TOKEN-1', 'PRIVATE KEY']) expect(printed).not.toContain(secret);
  });

  it('si SUNAT no devuelve access_token, el error lista los campos recibidos pero no sus valores', async () => {
    const { client } = makeClient([{ body: { accessToken: 'TOKEN-CON-OTRO-NOMBRE', expires_in: 3600 } }]);
    const error = await client
      .sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatApiError);
    expect((error as SunatApiError).message).toContain('campos recibidos: accessToken, expires_in');
    expect(inspect(error, { depth: Number.POSITIVE_INFINITY })).not.toContain('TOKEN-CON-OTRO-NOMBRE');
  });
});

describe('guías fuera de producción (SUNAT no tiene ambiente de pruebas para la GRE)', () => {
  function build(
    environment: 'beta' | 'homologation',
    endpoints: { apiEndpoint?: string; authEndpoint?: string } = {},
  ) {
    const mock = mockFetch([TOKEN, SENT, accepted()]);
    const client = new SunatClient({
      environment,
      issuer: TEST_ISSUER,
      sol: { user: 'USUARIO1', password: 'clave-sol' },
      gre: { clientId: 'cid-123', clientSecret: 'secret-456', ...endpoints },
      signingKey: key,
      fetch: mock.fn,
      now: () => new Date('2026-10-31T15:30:00-05:00'),
      retry: { delayMs: 0 },
    });
    return { client, ...mock };
  }

  it.each(['beta', 'homologation'] as const)(
    'con environment %s, sendDespatch y getDespatchStatus fallan sin contactar a nadie',
    async (environment) => {
      const { client, fn } = build(environment);
      const sent = await client
        .sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling)
        .catch((e: unknown) => e);
      expect(sent).toBeInstanceOf(SunatError);
      expect((sent as Error).message).toContain('no tiene ambiente de pruebas');
      await expect(client.getDespatchStatus({ baseName: BASE, ticket: 'ticket-uuid-1' })).rejects.toThrow(
        'no tiene ambiente de pruebas',
      );
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it('con un solo endpoint explícito también falla (la otra llamada iría a producción)', async () => {
    const { client, fn } = build('beta', { apiEndpoint: 'https://simulador.local/v1' });
    await expect(client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling)).rejects.toThrow(
      'no tiene ambiente de pruebas',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('con apiEndpoint y authEndpoint explícitos (un simulador) sí envía', async () => {
    const { client, calls } = build('beta', {
      apiEndpoint: 'https://simulador.local/v1',
      authEndpoint: 'https://simulador.local/auth',
    });
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling);
    expect(result.status).toBe('accepted');
    expect(calls[0]!.url.startsWith('https://simulador.local/auth/')).toBe(true);
    expect(calls[1]!.url.startsWith('https://simulador.local/v1/')).toBe(true);
  });
});
