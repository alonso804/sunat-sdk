import { describe, expect, it, vi } from 'vitest';
import { downloadDespatchPdf, SunatApiError, SunatClient, SunatTransportError, SunatValidationError } from '../src';
import { parseCdrXml } from '../src/cdr';
import { cdrZipBase64, sampleDespatch, TEST_ISSUER, TEST_RUC, testCertificate } from './helpers';

const QR_URL = 'https://e-factura.sunat.gob.pe/v1/contribuyente/gre/comprobantes/descargaqr?hashqr=AAAAhashDePrueba==';

/** Estructura del CDR real de una GRE (recortada), con un hash inventado. */
const cdrXml = (reference: string) => `<?xml version="1.0" encoding="UTF-8"?>
<ar:ApplicationResponse xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ar="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2">
  <cac:DocumentResponse>
    <cac:Response>
      <cbc:ReferenceID>TZ01-2</cbc:ReferenceID>
      <cbc:ResponseCode>0</cbc:ResponseCode>
      <cbc:Description><![CDATA[El Comprobante numero TZ01-2, ha sido aceptado]]></cbc:Description>
    </cac:Response>
    ${reference}
  </cac:DocumentResponse>
</ar:ApplicationResponse>`;

const withReference = (url: string) =>
  `<cac:DocumentReference><cbc:ID><![CDATA[TZ01-2]]></cbc:ID><cbc:DocumentDescription>${url}</cbc:DocumentDescription></cac:DocumentReference>`;

describe('qrUrl en el CDR de la GRE', () => {
  it('lee la URL del QR que entrega SUNAT', () => {
    const cdr = parseCdrXml(cdrXml(withReference(QR_URL)));
    expect(cdr.accepted).toBe(true);
    expect(cdr.qrUrl).toBe(QR_URL);
  });

  it('no trae qrUrl si el CDR no lo incluye (p. ej. facturas)', () => {
    const cdr = parseCdrXml(cdrXml(''));
    expect(cdr.qrUrl).toBeUndefined();
    expect('qrUrl' in cdr).toBe(false);
  });

  it('ignora una referencia que no sea https de sunat.gob.pe', () => {
    expect(parseCdrXml(cdrXml(withReference('https://malo.example.com/descargaqr?x=1'))).qrUrl).toBeUndefined();
    expect(parseCdrXml(cdrXml(withReference('http://e-factura.sunat.gob.pe/x'))).qrUrl).toBeUndefined();
    expect(parseCdrXml(cdrXml(withReference('https://sunat.gob.pe.malo.example.com/x'))).qrUrl).toBeUndefined();
    expect(parseCdrXml(cdrXml(withReference('texto cualquiera'))).qrUrl).toBeUndefined();
  });
});

const pdfBytes = new TextEncoder().encode('%PDF-1.5\n%contenido de prueba');
const pdfResponse = (extra: Record<string, string> = {}) =>
  new Response(pdfBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=20000000001-09-TZ01-2-PDF.pdf',
      ...extra,
    },
  });

describe('downloadDespatchPdf', () => {
  it('descarga el PDF y devuelve el nombre sugerido por SUNAT', async () => {
    const fetchMock = vi.fn(async (_url: string) => pdfResponse());
    const result = await downloadDespatchPdf(QR_URL, { fetch: fetchMock as unknown as typeof fetch });
    expect(Buffer.from(result.pdf).toString('latin1').startsWith('%PDF-')).toBe(true);
    expect(result.fileName).toBe('20000000001-09-TZ01-2-PDF.pdf');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(QR_URL);
  });

  it('descarta un nombre de archivo con caracteres peligrosos', async () => {
    const fetchMock = vi.fn(async () =>
      pdfResponse({ 'Content-Disposition': 'attachment; filename="../../etc/passwd"' }),
    );
    const result = await downloadDespatchPdf(QR_URL, { fetch: fetchMock as unknown as typeof fetch });
    expect(result.fileName).toBeUndefined();
  });

  it('rechaza URLs que no sean la del QR de SUNAT, sin hacer ninguna petición', async () => {
    const fetchMock = vi.fn();
    const QR_PATH = '/v1/contribuyente/gre/comprobantes/descargaqr';
    for (const url of [
      'https://example.com/a.pdf',
      'http://e-factura.sunat.gob.pe/x',
      'file:///etc/passwd',
      'no es una url',
      // Otras direcciones de sunat.gob.pe: antes pasaban por ser https del dominio.
      'https://e-factura.sunat.gob.pe/otra/ruta?hashqr=abc',
      `https://www.sunat.gob.pe${QR_PATH}?hashqr=abc`,
      `https://e-factura.sunat.gob.pe:8443${QR_PATH}?hashqr=abc`,
      `https://usuario:clave@e-factura.sunat.gob.pe${QR_PATH}?hashqr=abc`,
      `http://e-factura.sunat.gob.pe${QR_PATH}?hashqr=abc`,
      `https://e-factura.sunat.gob.pe${QR_PATH}`,
      `https://e-factura.sunat.gob.pe${QR_PATH}?hashqr=`,
    ]) {
      await expect(downloadDespatchPdf(url, { fetch: fetchMock as unknown as typeof fetch })).rejects.toBeInstanceOf(
        SunatValidationError,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sigue una redirección a otro dominio de sunat.gob.pe', async () => {
    const NEXT = 'https://api-cpe.sunat.gob.pe/v1/descarga/guia.pdf';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: NEXT } }))
      .mockResolvedValueOnce(pdfResponse());
    const result = await downloadDespatchPdf(QR_URL, { fetch: fetchMock as unknown as typeof fetch });
    expect(result.pdf.length).toBeGreaterThan(5);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([QR_URL, NEXT]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('no sigue una redirección fuera de sunat.gob.pe ni la reintenta', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: 'https://malo.example.com/x.pdf' } }),
    );
    const error = await downloadDespatchPdf(QR_URL, {
      fetch: fetchMock as unknown as typeof fetch,
      retry: { delayMs: 1 },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reintenta ante errores 5xx y luego descarga', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(pdfResponse());
    const result = await downloadDespatchPdf(QR_URL, {
      fetch: fetchMock as unknown as typeof fetch,
      retry: { delayMs: 1 },
    });
    expect(result.pdf.length).toBeGreaterThan(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reintenta ante un fallo de red y, si persiste, lanza SunatTransportError', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const error = await downloadDespatchPdf(QR_URL, {
      fetch: fetchMock as unknown as typeof fetch,
      retry: { maxRetries: 2, delayMs: 1 },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatTransportError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('no reintenta un 404 (el enlace no existe)', async () => {
    const fetchMock = vi.fn(async () => new Response('no existe', { status: 404 }));
    const error = (await downloadDespatchPdf(QR_URL, {
      fetch: fetchMock as unknown as typeof fetch,
      retry: { delayMs: 1 },
    }).catch((e: unknown) => e)) as SunatApiError;
    expect(error).toBeInstanceOf(SunatApiError);
    expect(error.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rechaza una respuesta 200 que no es un PDF (p. ej. una página de error)', async () => {
    const fetchMock = vi.fn(
      async () => new Response('<html>Error</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    await expect(downloadDespatchPdf(QR_URL, { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(
      /no es un PDF/,
    );
  });

  const MiB = 1024 * 1024;

  /** Cuerpo que entrega `chunks` partes de `chunkSize` bytes (la primera empieza con `first`) y cuenta cuántas pidió el lector. */
  function countedBody(first: string, chunkSize: number, chunks: number) {
    const state = { pulls: 0 };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulls++;
        const chunk = new Uint8Array(chunkSize).fill(0x20);
        if (state.pulls === 1) chunk.set(new TextEncoder().encode(first));
        controller.enqueue(chunk);
        if (state.pulls === chunks) controller.close();
      },
    });
    return { stream, state };
  }

  it('rechaza sin leer el cuerpo si Content-Length pasa de 10 MB, y no reintenta', async () => {
    const { stream, state } = countedBody('%PDF-1.5', MiB, 20);
    const fetchMock = vi.fn(
      async () => new Response(stream, { status: 200, headers: { 'Content-Length': String(20 * MiB) } }),
    );
    const error = (await downloadDespatchPdf(QR_URL, {
      fetch: fetchMock as unknown as typeof fetch,
      retry: { delayMs: 1 },
    }).catch((e: unknown) => e)) as SunatApiError;
    expect(error).toBeInstanceOf(SunatApiError);
    expect(error.message).toMatch(/tamaño máximo/);
    expect(error.retryable).toBe(false);
    expect(state.pulls).toBeLessThanOrEqual(1); // a lo sumo el que el stream pide solo al crearse
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('corta la descarga al pasar de 10 MB aunque no haya Content-Length', async () => {
    const { stream, state } = countedBody('%PDF-1.5', MiB, 20);
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200 }));
    const error = (await downloadDespatchPdf(QR_URL, {
      fetch: fetchMock as unknown as typeof fetch,
      retry: { delayMs: 1 },
    }).catch((e: unknown) => e)) as SunatApiError;
    expect(error).toBeInstanceOf(SunatApiError);
    expect(error.message).toMatch(/tamaño máximo/);
    expect(state.pulls).toBeLessThanOrEqual(12); // 11 partes leídas (> 10 MB) y una que el stream pide por adelantado
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deja de leer una respuesta que no es PDF apenas lo detecta y guarda su comienzo', async () => {
    const { stream, state } = countedBody('<html>Error de SUNAT</html>', 1024, 50);
    const fetchMock = vi.fn(
      async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    const error = (await downloadDespatchPdf(QR_URL, { fetch: fetchMock as unknown as typeof fetch }).catch(
      (e: unknown) => e,
    )) as SunatApiError;
    expect(error).toBeInstanceOf(SunatApiError);
    expect(error.message).toMatch(/no es un PDF/);
    expect(error.rawBody?.startsWith('<html>Error de SUNAT</html>')).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(2);
  });

  it('si la conexión se corta a mitad del PDF, reintenta como un fallo de red', async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('%PDF-1.5\n'));
        controller.error(new TypeError('terminated'));
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(cut, { status: 200 }))
      .mockResolvedValueOnce(pdfResponse());
    const result = await downloadDespatchPdf(QR_URL, {
      fetch: fetchMock as unknown as typeof fetch,
      retry: { delayMs: 1 },
    });
    expect(Buffer.from(result.pdf).toString('latin1')).toBe('%PDF-1.5\n%contenido de prueba');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('si la conexión se corta en todos los intentos, lanza SunatTransportError', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError('terminated'));
            },
          }),
          { status: 200 },
        ),
    );
    const error = await downloadDespatchPdf(QR_URL, {
      fetch: fetchMock as unknown as typeof fetch,
      retry: { maxRetries: 1, delayMs: 1 },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SunatTransportError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('sendDespatch con downloadPdf', () => {
  const BASE = `${TEST_RUC}-09-T001-1`;
  const { key } = testCertificate();
  const fastPolling = { pollIntervalMs: 1, sleep: async () => {} };
  const jsonReply = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  /** Fetch simulado que responde según la dirección: token, envío, estado del ticket y PDF. */
  function setup(pdfReply: () => Response, cdr = cdrXml(withReference(QR_URL))) {
    const urls: string[] = [];
    const fn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/oauth2/token')) return jsonReply({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 });
      if (u.includes('/envios/'))
        return jsonReply({ codRespuesta: '0', indCdrGenerado: '1', arcCdr: cdrZipBase64(BASE, cdr) });
      if (u.includes('/gem/comprobantes/'))
        return jsonReply({ numTicket: 'ticket-1', fecRecepcion: '2026-10-31T15:30:01.000-05:00' });
      if (u.includes('descargaqr')) return pdfReply();
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
    });
    return { client, urls };
  }

  it('con downloadPdf devuelve el PDF oficial junto al CDR', async () => {
    const { client, urls } = setup(() => pdfResponse());
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), {
      ...fastPolling,
      downloadPdf: true,
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.cdr.qrUrl).toBe(QR_URL);
    expect(Buffer.from(result.pdf!.pdf).toString('latin1').startsWith('%PDF-')).toBe(true);
    expect(result.pdf!.fileName).toBe('20000000001-09-TZ01-2-PDF.pdf');
    expect(result.pdfError).toBeUndefined();
    expect(urls.filter((u) => u.includes('descargaqr'))).toHaveLength(1);
  });

  it('por defecto NO descarga el PDF (no hace esa petición)', async () => {
    const { client, urls } = setup(() => pdfResponse());
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), fastPolling);
    expect(result.status).toBe('accepted');
    expect('pdf' in result).toBe(false);
    expect(urls.some((u) => u.includes('descargaqr'))).toBe(false);
  });

  it('si el PDF no se puede bajar, la guía sigue aceptada y el motivo queda en pdfError', async () => {
    const { client } = setup(() => new Response('no existe', { status: 404 }));
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), {
      ...fastPolling,
      downloadPdf: true,
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.pdf).toBeUndefined();
    expect(result.pdfError).toBeInstanceOf(SunatApiError);
  });

  it('si el CDR no trae la URL del QR, avisa en pdfError y no intenta descargar nada', async () => {
    const { client, urls } = setup(() => pdfResponse(), cdrXml(''));
    const result = await client.sendDespatch(client.prepareDespatch(sampleDespatch()), {
      ...fastPolling,
      downloadPdf: true,
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.pdfError?.message).toMatch(/URL del QR/);
    expect(urls.some((u) => u.includes('descargaqr'))).toBe(false);
  });
});
