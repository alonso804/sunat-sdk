import { describe, expect, it, vi } from 'vitest';
import { SunatClient, SunatFaultError, SunatTransportError } from '../src';
import { parseCdrXml, readCdrFromApplicationResponse } from '../src/cdr';
import { buildSendBillEnvelope, parseSendBillResponse } from '../src/soap/bill-service';
import { unzipFiles, zipSingleFile } from '../src/zip';
import { TEST_ISSUER, cdrXml, faultResponse, sampleInvoice, sendBillOkResponse, testCertificate } from './helpers';

const BASE = '20000000001-01-F001-1';

describe('zip', () => {
  it('comprime y descomprime un archivo', () => {
    const zip = zipSingleFile('a.xml', '<a>ñ</a>');
    expect(Buffer.from(unzipFiles(zip)['a.xml']!).toString('utf8')).toBe('<a>ñ</a>');
  });
});

describe('sobre SOAP', () => {
  it('incluye WS-Security con usuario y clave, y el archivo en base64', () => {
    const envelope = buildSendBillEnvelope({ username: '20000000001MODDATOS', password: 'MOD&DATOS' }, `${BASE}.zip`, 'QUJD');
    expect(envelope).toContain('<wsse:Username>20000000001MODDATOS</wsse:Username>');
    expect(envelope).toContain('PasswordText">MOD&amp;DATOS</wsse:Password>');
    expect(envelope).toContain(`<fileName>${BASE}.zip</fileName>`);
    expect(envelope).toContain('<contentFile>QUJD</contentFile>');
    expect(envelope).toContain('<ser:sendBill>');
  });
});

describe('respuestas de sendBill', () => {
  it('devuelve el applicationResponse cuando todo sale bien', () => {
    const body = sendBillOkResponse(BASE, cdrXml({ reference: 'F001-1', code: '0', description: 'ok' }));
    expect(parseSendBillResponse(200, body).length).toBeGreaterThan(20);
  });

  it('interpreta una excepción de SUNAT (0100–1999): el documento queda "no informado"', () => {
    try {
      parseSendBillResponse(500, faultResponse('soap-env:Client.0111', 'No tiene el perfil para enviar comprobantes'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SunatFaultError);
      const fault = error as SunatFaultError;
      expect(fault.code).toBe('0111');
      expect(fault.kind).toBe('exception');
      expect(fault.httpStatus).toBe(500);
    }
  });

  it('acepta un Fault con HTTP 200 (SUNAT lo hace con el código 1036)', () => {
    try {
      parseSendBillResponse(200, faultResponse('soap-env:Client.1036', 'Número de documento no coincide'));
      expect.unreachable();
    } catch (error) {
      expect((error as SunatFaultError).code).toBe('1036');
    }
  });

  it('decodifica las referencias numéricas (&#243;) que SUNAT usa para los acentos', () => {
    try {
      parseSendBillResponse(500, faultResponse('soap-env:Client.2335', 'El documento electr&amp;#243;nico ingresado ha sido alterado &#8211; fin'));
      expect.unreachable();
    } catch (error) {
      expect((error as SunatFaultError).sunatMessage).toBe('El documento electrónico ingresado ha sido alterado – fin');
    }
  });

  it('interpreta un rechazo de validación (2000–3999)', () => {
    try {
      parseSendBillResponse(500, faultResponse('soap-env:Client.2335', 'El documento electrónico ingresado ha sido alterado'));
      expect.unreachable();
    } catch (error) {
      expect((error as SunatFaultError).kind).toBe('rejected');
    }
  });

  it('toma el código del faultstring si el faultcode no lo trae', () => {
    try {
      parseSendBillResponse(500, faultResponse('soap-env:Server', '3030 - algo salió mal'));
      expect.unreachable();
    } catch (error) {
      expect((error as SunatFaultError).code).toBe('3030');
    }
  });

  it('no toma como código un número en medio del faultstring (p. ej. la serie y el número)', () => {
    try {
      parseSendBillResponse(500, faultResponse('soap-env:Server', 'Error al procesar F001-2500'));
      expect.unreachable();
    } catch (error) {
      expect((error as SunatFaultError).kind).toBe('unknown');
    }
  });

  it('trata una respuesta sin fault ni CDR como error de transporte reintentable', () => {
    expect(() => parseSendBillResponse(502, '<html>Bad gateway</html>')).toThrow(SunatTransportError);
    try {
      parseSendBillResponse(401, '<html><body><h1>401 Authorization Required</h1></body></html>');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SunatTransportError);
      expect((error as SunatTransportError).httpStatus).toBe(401);
      expect((error as SunatTransportError).retryable).toBe(true);
    }
  });
});

describe('CDR', () => {
  it('lee un CDR aceptado', () => {
    const cdr = parseCdrXml(cdrXml({ reference: 'F001-1', code: '0', description: 'La Factura numero F001-1, ha sido aceptada' }));
    expect(cdr).toMatchObject({ referenceId: 'F001-1', responseCode: '0', accepted: true, notes: [] });
  });

  it('lee observaciones', () => {
    const cdr = parseCdrXml(cdrXml({ reference: 'F001-1', code: '0', description: 'ok', notes: ['4287 - observación A', '4288 - observación B'] }));
    expect(cdr.notes).toEqual(['4287 - observación A', '4288 - observación B']);
  });

  it('lee el CDR desde el ZIP en base64 de la respuesta', () => {
    const zip = zipSingleFile(`R-${BASE}.xml`, cdrXml({ reference: 'F001-1', code: '0', description: 'ok' }));
    const { cdr } = readCdrFromApplicationResponse(Buffer.from(zip).toString('base64'));
    expect(cdr.accepted).toBe(true);
  });
});

describe('SunatClient.sendInvoice (fetch simulado)', () => {
  const { key } = testCertificate();
  const makeClient = (fetchMock: typeof fetch, retry: { maxRetries?: number } = {}) =>
    new SunatClient({
      environment: 'beta',
      issuer: TEST_ISSUER,
      sol: { user: 'MODDATOS', password: 'MODDATOS' },
      signingKey: key,
      fetch: fetchMock,
      retry: { delayMs: 0, ...retry },
    });
  const respond = (body: string, status = 200) => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

  it('envía el ZIP con el nombre correcto y devuelve aceptada', async () => {
    const fetchMock = respond(sendBillOkResponse(BASE, cdrXml({ reference: 'F001-1', code: '0', description: 'aceptada' })));
    const client = makeClient(fetchMock);
    const result = await client.sendInvoice(client.prepareInvoice(sampleInvoice()));

    expect(result.status).toBe('accepted');
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService');
    const sent = String(init.body);
    expect(sent).toContain(`<fileName>${BASE}.zip</fileName>`);
    expect(sent).toContain('<wsse:Username>20000000001MODDATOS</wsse:Username>');

    // El ZIP enviado contiene el XML firmado con el nombre esperado.
    const base64 = /<contentFile>([^<]+)<\/contentFile>/.exec(sent)![1]!;
    const files = unzipFiles(new Uint8Array(Buffer.from(base64, 'base64')));
    expect(Object.keys(files)).toEqual([`${BASE}.xml`]);
  });

  it('marca aceptada con observaciones', async () => {
    const client = makeClient(respond(sendBillOkResponse(BASE, cdrXml({ reference: 'F001-1', code: '0', description: 'ok', notes: ['4287 - obs'] }))));
    const result = await client.sendInvoice(client.prepareInvoice(sampleInvoice()));
    expect(result.status).toBe('accepted_with_observations');
  });

  it('devuelve rechazada (sin lanzar) cuando SUNAT rechaza por validación', async () => {
    const client = makeClient(respond(faultResponse('soap-env:Client.2335', 'documento alterado'), 500));
    const result = await client.sendInvoice(client.prepareInvoice(sampleInvoice()));
    expect(result).toMatchObject({ status: 'rejected', code: '2335', message: 'documento alterado' });
  });

  it('lanza cuando SUNAT devuelve una excepción (el comprobante quedó no informado)', async () => {
    const client = makeClient(respond(faultResponse('soap-env:Client.1036', 'nombre de archivo no coincide'), 200));
    const error = await client.sendInvoice(client.prepareInvoice(sampleInvoice())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatFaultError);
    expect((error as SunatFaultError).kind).toBe('exception');
  });

  it('lanza SunatTransportError si falla la red', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = makeClient(failing);
    await expect(client.sendInvoice(client.prepareInvoice(sampleInvoice()))).rejects.toBeInstanceOf(SunatTransportError);
  });

  describe('reintentos', () => {
    const ok = () => new Response(sendBillOkResponse(BASE, cdrXml({ reference: 'F001-1', code: '0', description: 'aceptada' })), { status: 200 });
    const proxy401 = () => new Response('<html><body><h1>401 Authorization Required</h1></body></html>', { status: 401 });
    /** Error de `fetch` cuando la conexión no llegó a abrirse (misma forma que produce Node). */
    const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const calls = (mock: unknown) => (mock as ReturnType<typeof vi.fn>).mock.calls.length;

    it('reintenta el 401 del proxy (peticiones muy seguidas) y la factura queda aceptada', async () => {
      const mock = vi.fn().mockResolvedValueOnce(proxy401()).mockResolvedValueOnce(proxy401()).mockResolvedValueOnce(ok());
      const client = makeClient(mock as unknown as typeof fetch);
      const result = await client.sendInvoice(client.prepareInvoice(sampleInvoice()));
      expect(result.status).toBe('accepted');
      expect(calls(mock)).toBe(3);
    });

    it('un 401 persistente se reintenta con tope y luego lanza', async () => {
      const mock = vi.fn(async () => proxy401());
      const client = makeClient(mock as unknown as typeof fetch, { maxRetries: 2 });
      const error = await client.sendInvoice(client.prepareInvoice(sampleInvoice())).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SunatTransportError);
      expect((error as SunatTransportError).httpStatus).toBe(401);
      expect(calls(mock)).toBe(3); // 1 intento + 2 reintentos
    });

    it('reintenta si la conexión no llegó a abrirse', async () => {
      const mock = vi.fn().mockRejectedValueOnce(refused()).mockResolvedValueOnce(ok());
      const client = makeClient(mock as unknown as typeof fetch);
      expect((await client.sendInvoice(client.prepareInvoice(sampleInvoice()))).status).toBe('accepted');
      expect(calls(mock)).toBe(2);
    });

    it('NO reenvía si la petición pudo haber llegado (corte, espera agotada o 502)', async () => {
      const failures: Array<() => Promise<Response>> = [
        async () => {
          throw new TypeError('fetch failed'); // corte sin código de conexión: ambiguo
        },
        async () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
        async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      ];
      for (const failure of failures) {
        const mock = vi.fn(failure);
        const client = makeClient(mock as unknown as typeof fetch);
        await expect(client.sendInvoice(client.prepareInvoice(sampleInvoice()))).rejects.toBeInstanceOf(SunatTransportError);
        expect(calls(mock)).toBe(1);
      }
    });

    it('no reintenta un fault de SUNAT (rechazo o excepción)', async () => {
      const mock = vi.fn(async () => new Response(faultResponse('soap-env:Client.0111', 'No tiene el perfil'), { status: 500 }));
      const client = makeClient(mock as unknown as typeof fetch);
      await expect(client.sendInvoice(client.prepareInvoice(sampleInvoice()))).rejects.toBeInstanceOf(SunatFaultError);
      expect(calls(mock)).toBe(1);
    });

    it('`maxRetries: 0` desactiva los reintentos', async () => {
      const mock = vi.fn(async () => proxy401());
      const client = makeClient(mock as unknown as typeof fetch, { maxRetries: 0 });
      await expect(client.sendInvoice(client.prepareInvoice(sampleInvoice()))).rejects.toBeInstanceOf(SunatTransportError);
      expect(calls(mock)).toBe(1);
    });
  });
});
