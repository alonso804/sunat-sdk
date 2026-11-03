import { describe, expect, it, vi } from 'vitest';
import { SunatClient, SunatError, SunatFaultError, SunatTransportError, SunatValidationError } from '../src';
import { buildGetStatusCdrEnvelope, parseGetStatusCdrResponse } from '../src/soap/bill-service';
import { TEST_ISSUER, TEST_RUC, cdrXml, cdrZipBase64, faultResponse, testCertificate } from './helpers';

const BASE = `${TEST_RUC}-01-F001-1`;

const statusResponse = (code: string, message: string, content?: string) =>
  '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>' +
  '<ns0:getStatusCdrResponse xmlns:ns0="http://service.sunat.gob.pe"><statusCdr>' +
  `<statusCode>${code}</statusCode>${content ? `<content>${content}</content>` : ''}<statusMessage>${message}</statusMessage>` +
  '</statusCdr></ns0:getStatusCdrResponse></S:Body></S:Envelope>';

describe('getStatusCdr: sobre y respuesta', () => {
  it('arma el sobre con WS-Security y los cuatro datos del comprobante', () => {
    const envelope = buildGetStatusCdrEnvelope(
      { username: `${TEST_RUC}USUARIO1`, password: 'clave&sol' },
      { ruc: TEST_RUC, type: '01', series: 'F001', number: 12 },
    );
    expect(envelope).toContain(`<wsse:Username>${TEST_RUC}USUARIO1</wsse:Username>`);
    expect(envelope).toContain('PasswordText">clave&amp;sol</wsse:Password>');
    expect(envelope).toContain('<ser:getStatusCdr>');
    expect(envelope).toContain(`<rucComprobante>${TEST_RUC}</rucComprobante>`);
    expect(envelope).toContain('<tipoComprobante>01</tipoComprobante>');
    expect(envelope).toContain('<serieComprobante>F001</serieComprobante>');
    expect(envelope).toContain('<numeroComprobante>12</numeroComprobante>');
  });

  it('lee código, mensaje y el CDR adjunto', () => {
    const content = cdrZipBase64(BASE, cdrXml({ reference: 'F001-1', code: '0', description: 'ok' }));
    const parsed = parseGetStatusCdrResponse(200, statusResponse('0001', 'El comprobante existe y est&#225; aceptado.', content));
    expect(parsed.statusCode).toBe('0001');
    expect(parsed.statusMessage).toBe('El comprobante existe y está aceptado.');
    expect(parsed.contentBase64).toBe(content);
  });

  it('sin CDR adjunto, devuelve solo el código y el mensaje', () => {
    const parsed = parseGetStatusCdrResponse(200, statusResponse('0011', 'El comprobante no existe'));
    expect(parsed).toEqual({ statusCode: '0011', statusMessage: 'El comprobante no existe', contentBase64: undefined });
  });

  it('un Fault de SUNAT se lanza como SunatFaultError con su código', () => {
    const error = (() => {
      try {
        parseGetStatusCdrResponse(500, faultResponse('soap-env:Client.0111', 'El usuario no tiene el perfil necesario'));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(SunatFaultError);
    expect((error as SunatFaultError).code).toBe('0111');
  });

  it('una respuesta sin statusCdr es un error de transporte reintentable', () => {
    expect(() => parseGetStatusCdrResponse(503, '<html>Servicio no disponible</html>')).toThrow(SunatTransportError);
  });
});

describe('SunatClient.getInvoiceStatus', () => {
  const { key } = testCertificate();
  const makeClient = (fetchMock: typeof fetch, environment: 'beta' | 'production' = 'production') =>
    new SunatClient({
      environment,
      issuer: TEST_ISSUER,
      sol: { user: 'USUARIO1', password: 'clave-sol' },
      signingKey: key,
      fetch: fetchMock,
      retry: { delayMs: 0 },
    });
  const respond = (body: string, status = 200) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body, { status }));

  it('consulta el servicio de producción y devuelve el CDR', async () => {
    const content = cdrZipBase64(BASE, cdrXml({ reference: 'F001-1', code: '0', description: 'La Factura numero F001-1, ha sido aceptada' }));
    const mock = respond(statusResponse('0001', 'El comprobante existe y esta aceptado.', content));
    const result = await makeClient(mock as unknown as typeof fetch).getInvoiceStatus({ series: 'f001', number: 1 });

    expect(result.statusCode).toBe('0001');
    expect(result.cdr?.accepted).toBe(true);
    expect(result.cdr?.referenceId).toBe('F001-1');
    expect(result.cdrZip?.length).toBeGreaterThan(0);

    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toBe('https://e-factura.sunat.gob.pe/ol-it-wsconscpegem/billConsultService');
    expect((init?.headers as Record<string, string>).SOAPAction).toBe('urn:getStatusCdr');
    const body = String(init?.body);
    expect(body).toContain(`<wsse:Username>${TEST_RUC}USUARIO1</wsse:Username>`); // RUC + usuario SOL
    expect(body).toContain(`<rucComprobante>${TEST_RUC}</rucComprobante>`); // siempre el emisor del cliente
    expect(body).toContain('<serieComprobante>F001</serieComprobante>'); // en mayúsculas
  });

  it('si SUNAT no adjunta CDR, devuelve el código sin cdr', async () => {
    const mock = respond(statusResponse('0011', 'El comprobante de pago electronico no existe.'));
    const result = await makeClient(mock as unknown as typeof fetch).getInvoiceStatus({ series: 'F001', number: 99_999_999 });
    expect(result).toEqual({ statusCode: '0011', statusMessage: 'El comprobante de pago electronico no existe.' });
    expect('cdr' in result).toBe(false);
  });

  it('no existe en beta: lo dice sin contactar a SUNAT', async () => {
    const mock = respond('');
    await expect(makeClient(mock as unknown as typeof fetch, 'beta').getInvoiceStatus({ series: 'F001', number: 1 })).rejects.toThrow(/solo lo publica para producción/);
    expect(mock).not.toHaveBeenCalled();
  });

  it('valida los datos antes de contactar a SUNAT', async () => {
    const mock = respond('');
    const client = makeClient(mock as unknown as typeof fetch);
    for (const query of [
      { series: 'F01', number: 1 },
      { series: 'F-01', number: 1 },
      { series: 'F001', number: 0 },
      { series: 'F001', number: 1.5 },
      { series: 'F001', number: 100_000_000 },
      { series: 'F001', number: 1, type: '03' as never },
    ]) {
      await expect(client.getInvoiceStatus(query)).rejects.toBeInstanceOf(SunatValidationError);
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it('propaga la excepción de SUNAT (p. ej. el usuario no tiene perfil)', async () => {
    const mock = respond(faultResponse('soap-env:Client.0111', 'No tiene el perfil necesario'), 500);
    const error = await makeClient(mock as unknown as typeof fetch).getInvoiceStatus({ series: 'F001', number: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatFaultError);
    expect(error).toBeInstanceOf(SunatError);
  });

  it('un fallo de red persistente es SunatTransportError, tras reintentar (es solo lectura)', async () => {
    const mock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(makeClient(mock as unknown as typeof fetch).getInvoiceStatus({ series: 'F001', number: 1 })).rejects.toBeInstanceOf(SunatTransportError);
    expect(mock).toHaveBeenCalledTimes(4); // 1 intento + 3 reintentos
  });

  it('reintenta un fallo pasajero y devuelve el estado', async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('<html>502 Bad Gateway</html>', { status: 502 }))
      .mockResolvedValueOnce(new Response(statusResponse('0011', 'El comprobante de pago electronico no existe.'), { status: 200 }));
    const result = await makeClient(mock as unknown as typeof fetch).getInvoiceStatus({ series: 'F001', number: 1 });
    expect(result.statusCode).toBe('0011');
    expect(mock).toHaveBeenCalledTimes(3);
  });
});
