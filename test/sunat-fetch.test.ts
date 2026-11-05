import { describe, expect, it, vi } from 'vitest';
import { SunatClient, SunatTransportError } from '../src';
import { fetchWithCredentials } from '../src/sunat-fetch';
import { cdrXml, sampleInvoice, sendBillOkResponse, TEST_ISSUER, testCertificate } from './helpers';

const BASE = '20000000001-01-F001-1';
const BETA = 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService';

const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });

/** Fetch simulado que responde en orden y registra cada llamada. */
function mockFetch(replies: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = replies.shift();
    if (!next) throw new Error(`Llamada inesperada a ${String(url)}`);
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('fetchWithCredentials (redirecciones de peticiones con credenciales)', () => {
  const post = { method: 'POST', body: '<wsse:Password>clave-sol</wsse:Password>' };

  it('sin redirección devuelve la respuesta tal cual y pide redirect manual', async () => {
    const { fn, calls } = mockFetch([new Response('ok', { status: 200 })]);
    const response = await fetchWithCredentials(fn, BETA, post);
    expect(await response.text()).toBe('ok');
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('sigue un 307 a https de *.sunat.gob.pe con el mismo método y cuerpo', async () => {
    const other = 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService';
    const { fn, calls } = mockFetch([redirect(307, other), new Response('ok', { status: 200 })]);
    const response = await fetchWithCredentials(fn, BETA, post);
    expect(response.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([BETA, other]);
    expect(calls[1]!.init.method).toBe('POST');
    expect(calls[1]!.init.body).toBe(post.body);
  });

  it.each([
    ['otro dominio', 'https://evil.example/billService'],
    ['http de SUNAT', 'http://e-beta.sunat.gob.pe/billService'],
    ['un dominio que solo termina en sunat.gob.pe', 'https://sunat.gob.pe.evil.example/x'],
  ])('no sigue un 307 hacia %s: no envía nada al nuevo destino', async (_label, target) => {
    const { fn, calls } = mockFetch([redirect(307, target)]);
    const error = await fetchWithCredentials(fn, BETA, post).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatTransportError);
    expect((error as SunatTransportError).httpStatus).toBe(307);
    expect((error as SunatTransportError).retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('permite redirecciones dentro del mismo origen configurado (simulador o proxy)', async () => {
    const { fn, calls } = mockFetch([redirect(308, '/v2/token'), new Response('ok', { status: 200 })]);
    await fetchWithCredentials(fn, 'http://127.0.0.1:8080/v1/token', post);
    expect(calls[1]!.url).toBe('http://127.0.0.1:8080/v2/token');
  });

  it('no sigue un 302 de un POST (fetch lo convertiría en GET sin cuerpo)', async () => {
    const { fn, calls } = mockFetch([redirect(302, 'https://e-factura.sunat.gob.pe/x')]);
    await expect(fetchWithCredentials(fn, BETA, post)).rejects.toBeInstanceOf(SunatTransportError);
    expect(calls).toHaveLength(1);
  });

  it('sigue un 302 de un GET dentro de SUNAT (consulta del ticket)', async () => {
    const url = 'https://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes/envios/t-1';
    const moved = 'https://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes/envios/t-1/';
    const { fn, calls } = mockFetch([redirect(302, moved), new Response('{}', { status: 200 })]);
    await fetchWithCredentials(fn, url, { method: 'GET', headers: { Authorization: 'Bearer T' } });
    expect(calls[1]!.url).toBe(moved);
  });

  it('corta tras demasiadas redirecciones', async () => {
    const loop = () => redirect(307, BETA);
    const { fn, calls } = mockFetch([loop(), loop(), loop(), loop(), loop()]);
    await expect(fetchWithCredentials(fn, BETA, post)).rejects.toThrow('más de 3 veces');
    expect(calls).toHaveLength(4);
  });
});

describe('sendInvoice ante una redirección fuera de SUNAT', () => {
  const { key } = testCertificate();

  it('lanza SunatTransportError sin reenviar la clave SOL ni reintentar', async () => {
    const { fn, calls } = mockFetch([redirect(307, 'https://evil.example/billService')]);
    const client = new SunatClient({
      environment: 'beta',
      issuer: TEST_ISSUER,
      sol: { user: 'MODDATOS', password: 'MODDATOS' },
      signingKey: key,
      fetch: fn,
      retry: { delayMs: 0 },
    });
    const error = await client.sendInvoice(client.prepareInvoice(sampleInvoice())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatTransportError);
    expect((error as Error).message).toContain('no se siguió para no reenviar las credenciales');
    expect(calls.map((c) => c.url)).toEqual([BETA]);
  });

  it('sigue una redirección 307 dentro de SUNAT y la factura queda aceptada', async () => {
    const other = 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService2';
    const { fn, calls } = mockFetch([
      redirect(307, other),
      new Response(sendBillOkResponse(BASE, cdrXml({ reference: 'F001-1', code: '0', description: 'aceptada' }))),
    ]);
    const client = new SunatClient({
      environment: 'beta',
      issuer: TEST_ISSUER,
      sol: { user: 'MODDATOS', password: 'MODDATOS' },
      signingKey: key,
      fetch: fn,
      retry: { delayMs: 0 },
    });
    const result = await client.sendInvoice(client.prepareInvoice(sampleInvoice()));
    expect(result.status).toBe('accepted');
    expect(calls[1]!.url).toBe(other);
    expect(String(calls[1]!.init.body)).toContain('<wsse:Username>20000000001MODDATOS</wsse:Username>');
  });
});
