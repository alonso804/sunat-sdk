# Cambios

## 0.2.0

### Antes de actualizar: cambios incompatibles

1. **`downloadDespatchPdf`: los reintentos se configuran con `retry`**, igual que en `SunatClientConfig.retry` (función
   suelta y método de `SunatClient`).

   ```ts
   // 0.1.0
   await client.downloadDespatchPdf(qrUrl, { retries: 2, retryDelayMs: 1000 });
   // 0.2.0
   await client.downloadDespatchPdf(qrUrl, { retry: { maxRetries: 2, delayMs: 1000 } });
   ```

2. **`downloadDespatchPdf` solo acepta la URL del QR tal como la entrega SUNAT en el CDR**
   (`https://e-factura.sunat.gob.pe/v1/contribuyente/gre/comprobantes/descargaqr?hashqr=…`). Antes aceptaba cualquier
   URL `https` de `*.sunat.gob.pe`. Pásale la `cdr.qrUrl` que guardaste al emitir; cualquier otra lanza
   `SunatValidationError` sin hacer la petición. Además corta la descarga si el PDF pasa de 10 MB.

3. **Las guías solo se envían con `environment: 'production'`.** SUNAT no tiene ambiente de pruebas para la GRE y la
   0.1.0 usaba siempre los endpoints de producción: un cliente `beta` con credenciales reales emitía guías reales.
   Ahora `sendDespatch` y `getDespatchStatus` lanzan `SunatError` sin contactar a nadie fuera de `production`, salvo
   que indiques `gre.apiEndpoint` y `gre.authEndpoint` (un simulador). Si tu app usa un cliente `beta` para facturas
   y también envía guías, crea otro cliente con `environment: 'production'` para las guías.

4. **Las peticiones con credenciales no siguen redirecciones fuera de SUNAT.** El SOAP de facturas y la API de guías
   siguen una redirección solo hacia `https` de `*.sunat.gob.pe` o el mismo origen configurado (y en un `POST`, solo
   307/308). Cualquier otra se corta con `SunatTransportError` sin enviar nada al nuevo destino. Solo te afecta si
   pasas por un proxy que redirige a otro dominio.

No cambian los textos de los estados ni de las opciones (`'accepted'`, `'pending'`, `'beta'`, `'PEN'`…): el código
que compara o asigna strings sigue funcionando. Tampoco cambian los datos de entrada de facturas y guías.

### Nuevo

- **Consulta RUC** en la entrada aparte `@alonso804/sunat-sdk/ruc`: `consultRuc` devuelve razón social, nombre
  comercial, estado, condición, domicilio fiscal y actividad principal (`RucConsultStatus`, `RucPageError`,
  `curlFetch`, `isCurlAvailable`). No necesita credenciales. Ver la sección del README.
- **Estados y opciones como objetos `as const`**, que también son tipos con el mismo nombre: `SendInvoiceStatus`,
  `DespatchStatus`, `SunatFaultKind`, `Environment`, `SignatureAlgorithm`, `Currency`, `PaymentType`,
  `TransportMode` y `TextCharset`.
- **`textCharset`** en `SunatClientConfig`: con `TextCharset.latin1` cambia los caracteres fuera de Latin-1 por
  equivalentes simples antes de firmar (“ ” → ", — → -, € → EUR), para PDFs que arma SUNAT y muestran `?`. Por
  defecto (`unicode`) el texto se envía tal cual.
- Tipos con nombre en las firmas: `DespatchTicketRef`, `DespatchStatusOptions` y `DespatchPdfRetryOptions`.
- JSDoc en toda la API pública. Los comentarios de los campos de entrada se ven al autocompletar desde otro proyecto.
- El paquete incluye este `CHANGELOG.md`.

### Seguridad

Resultado de una auditoría de seguridad (2026-11-05), sin vulnerabilidades confirmadas; estos cambios endurecen el SDK:

- Imprimir el cliente (`console.log`, `util.inspect`, `JSON.stringify`) ya no muestra la clave SOL, el
  `clientSecret`, la llave privada ni el token de la API de guías. Si SUNAT responde sin token, el error lista solo
  los nombres de los campos recibidos, no sus valores.
- Guías solo en producción y redirecciones con credenciales limitadas a SUNAT (puntos 3 y 4 de arriba).
- `downloadDespatchPdf`: solo la URL del QR, tope de 10 MB y deja de leer apenas ve que la respuesta no es un PDF.
- `curlFetch` trata la URL, el cuerpo y las cabeceras como datos, igual que `fetch`: un cuerpo que empieza con `@`
  ya no hace que curl lea un archivo local, una URL con `[1-3]` no se expande en varias peticiones y solo se aceptan
  `http` y `https`. `consultRuc` envía los mismos bytes que antes.

### Correcciones

- `downloadDespatchPdf`: si la conexión se corta a mitad de la descarga, se reintenta como un fallo de red y, si
  persiste, termina en `SunatTransportError` (antes salía el error de red sin reintentar).

### Interno (no cambia el uso)

- Versiones exactas de las dependencias.
- Biome como linter y formateador.
- Validación contra los XSD de UBL con `xmllint-wasm`, sin instalar `xmllint`.
- CI en cada pull request y publicación automática en GitHub Packages al subir una etiqueta `v*`.
- Los scripts operativos entran en el typecheck.

## 0.1.0 (2026-11-03)

Primera versión publicada:

- Factura 01 (contado y crédito con cuotas, orden de compra, guías relacionadas) por SOAP `sendBill`, probada contra
  SUNAT beta.
- Guía de remisión del remitente (GRE 09) por la API REST, con token, ticket y CDR, probada en producción; si la
  consulta del ticket falla, devuelve `pending` con el ticket.
- PDF oficial de la guía desde la URL del QR (`downloadDespatchPdf`).
- Consulta de facturas ya informadas (`getInvoiceStatus`) y reintentos automáticos de los fallos pasajeros.
