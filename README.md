# sunat-sdk

SDK en TypeScript para emitir comprobantes electrónicos **directo a SUNAT** (sin PSE ni OSE),
pensado para usarse como paquete privado desde otras aplicaciones (desktop / móvil vía un backend Node).

> **Estado: en construcción.** La **guía de remisión del remitente (GRE 09)** está **probada en producción**
> (SUNAT no tiene ambiente de pruebas para la GRE) y validada contra el esquema UBL 2.1.
> La **factura electrónica (01)**, al contado y al crédito, funciona contra el ambiente **beta**; aún no se ha probado
> en homologación ni producción.

| Capacidad                                                                                                                                       | Estado                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Factura 01, contado, PEN/USD, gravado/exonerado/inafecto                                                                                        | ✅ aceptada por SUNAT beta (40 de 40 en pruebas aleatorias)                                                              |
| Firma XMLDSig, ZIP, SOAP `sendBill`, lectura del CDR                                                                                            | ✅                                                                                                                       |
| Resumen para confirmar antes de emitir (`prepareInvoice`, `prepareDespatch`)                                                                    | ✅                                                                                                                       |
| GRE remitente: XML UBL 2.1 + firma + API REST (token OAuth, ticket, CDR)                                                                        | ✅ probada en producción · validada con el XSD oficial                                                                   |
| Validación local contra los XSD de UBL 2.1 (`xmllint`)                                                                                          | ✅ facturas y 4 variantes de GRE                                                                                         |
| Factura a crédito (cuotas), orden de compra y guías relacionadas                                                                                | ✅ reglas verificadas contra SUNAT beta (ver más abajo)                                                                  |
| Descuentos, anticipos, detracción                                                                                                               | ⏳                                                                                                                       |
| Notas de crédito / débito, boletas                                                                                                              | ⏳                                                                                                                       |
| Consulta de estado / CDR de facturas (`getStatusCdr`, `getInvoiceStatus`)                                                                       | ✅ implementada · solo existe en producción                                                                              |
| Consulta de datos de un contribuyente por RUC (`consultRuc`: razón social, nombre comercial, estado, condición, domicilio, actividad principal) | ✅ implementada · sin credenciales · con el desafío de anti-bot en pie, usa el fallback de curl automático (ver sección) |
| GRE transportista, motivos de importación/exportación, baja de GRE por API                                                                      | ⏳                                                                                                                       |
| Lectura de comprobantes y guías emitidos (SIRE y otros)                                                                                         | ⏳                                                                                                                       |
| Generación de PDF / QR                                                                                                                          | ⏳                                                                                                                       |

## Requisitos

- Node **22 o superior** (se desarrolla con Node 26 LTS; ver `.nvmrc`, compatible con `fnm use`) y pnpm 11.
- Para producción: certificado digital (PFX) y credenciales SOL; ver el apartado de trámites más abajo.

## Uso

```ts
import { SunatClient, signingKeyFromPfx } from '@alonso804/sunat-sdk';
import { readFileSync } from 'node:fs';

const client = new SunatClient({
  environment: 'beta', // 'beta' | 'homologation' | 'production'
  issuer: {
    ruc: '20000000001',
    legalName: 'EMPRESA DE PRUEBAS SAC',
    address: { ubigeo: '150101', department: 'LIMA', province: 'LIMA', district: 'LIMA', street: 'AV. DE PRUEBA 123' },
  },
  sol: { user: 'MODDATOS', password: 'MODDATOS' }, // en producción: usuario SOL secundario
  signingKey: signingKeyFromPfx(readFileSync('certificado.pfx'), process.env.CERT_PASSWORD!),
});

// 1) Valida, calcula y firma. NO contacta a SUNAT: sirve para mostrar y confirmar.
const prepared = client.prepareInvoice({
  series: 'F001',
  number: 1,
  customer: { ruc: '20131312955', name: 'CLIENTE SAC' },
  items: [{ description: 'CEMENTO 42.5 KG', quantity: 10, unitPrice: 29.5 }], // precio CON IGV
});
console.log(prepared.summary); // totales, líneas, monto en letras

// 2) Recién aquí se envía (acción con efecto tributario en producción).
const result = await client.sendInvoice(prepared);
// result.status: 'accepted' | 'accepted_with_observations' | 'rejected'  (ver "Estados")
```

#### Estados y opciones

Los estados y las opciones con valores fijos son objetos `as const` (no `enum`) y a la vez tipos con el mismo nombre, como
las clases de error: se puede comparar o asignar con el objeto o con el texto, y usar el nombre como tipo.

```ts
import { SendInvoiceStatus } from '@alonso804/sunat-sdk';

if (result.status === SendInvoiceStatus.rejected) {
  /* el correlativo quedó consumido */
}
function label(status: SendInvoiceStatus) {
  /* 'accepted' | 'accepted_with_observations' | 'rejected' */
}
```

| Objeto y tipo                  | Valores                                                       | Dónde                                  |
| ------------------------------ | ------------------------------------------------------------- | -------------------------------------- |
| `SendInvoiceStatus`            | `accepted`, `acceptedWithObservations`, `rejected`            | `sendInvoice`                          |
| `DespatchStatus`               | `accepted`, `acceptedWithObservations`, `rejected`, `pending` | `sendDespatch`, `getDespatchStatus`    |
| `SunatFaultKind`               | `exception`, `rejected`, `unknown`                            | `SunatFaultError.kind`                 |
| `RucConsultStatus` (en `/ruc`) | `found`, `notFound`                                           | `consultRuc`                           |
| `Environment`                  | `beta`, `homologation`, `production`                          | `SunatClientConfig.environment`        |
| `SignatureAlgorithm`           | `sha1`, `sha256`                                              | `SunatClientConfig.signatureAlgorithm` |
| `Currency`                     | `PEN`, `USD`                                                  | `InvoiceInput.currency`                |
| `PaymentType`                  | `cash`, `credit`                                              | `InvoiceInput.payment.type`            |
| `TransportMode`                | `public`, `private`                                           | `DespatchInput.transportMode`          |
| `TextCharset`                  | `unicode`, `latin1`                                           | `SunatClientConfig.textCharset`        |

#### Factura al crédito, orden de compra y guía relacionada

```ts
const prepared = client.prepareInvoice({
  series: 'F001',
  number: 15,
  customer: { ruc: '20123456786', name: 'CLIENTE SAC' },
  items: [{ description: 'RECARGA DE EXTINTORES', quantity: 1, unitValue: 12 }],
  // Al crédito: el monto neto pendiente es el TOTAL de la factura por defecto (no hace falta escribirlo) y,
  // si no indicas montos, las cuotas se reparten en partes iguales (la diferencia de centavos va en la última).
  payment: { type: 'credit', installments: [{ dueDate: '2026-12-10' }, { dueDate: '2027-01-10' }] },
  purchaseOrder: '10194', // hasta 20 caracteres
  relatedDespatches: [{ series: 'T001', number: 15 }], // guía de remisión remitente (type '09'; '31' = transportista)
});
prepared.summary.total; // "14.16": ya disponible para mostrarlo mientras eliges las cuotas
prepared.summary.payment; // { type: 'credit', netPending: '14.16', installments: [{ number: 1, dueDate, amount: '7.08' }, …] }
```

Reglas verificadas contra el servicio de **beta** de SUNAT (el SDK las valida antes de enviar, porque un rechazo de una
factura consume el correlativo):

| Regla                                                                                | Código de SUNAT |
| ------------------------------------------------------------------------------------ | --------------- |
| Las cuotas deben sumar el monto neto pendiente                                       | 3319            |
| El monto neto pendiente no puede ser mayor al importe total (sí puede ser menor)     | 3265            |
| El vencimiento de cada cuota debe ser **posterior** a la fecha de emisión (no igual) | 3267            |
| Máximo 60 cuotas (límite de SOL)                                                     | —               |
| El orden de las cuotas no importa (SUNAT acepta fechas desordenadas)                 | —               |

Estructura del XML según el anexo 9-A de la RS 193-2020/SUNAT y la guía XML de factura UBL 2.1: `cac:PaymentTerms` con
`FormaPago`/`Credito` y el monto, más una línea `Cuota001`, `Cuota002`… con monto y `PaymentDueDate`;
`cac:OrderReference` para la orden de compra y `cac:DespatchDocumentReference` (código `09`) para la guía. Para los
atributos de la guía, la guía oficial muestra un `listName` que SUNAT beta observa (4252); el SDK usa
`listName="Tipo de Documento"`, que se acepta sin observaciones.

### Guía de remisión (remitente)

```ts
const client = new SunatClient({
  // …lo mismo que arriba, más las credenciales de API (SOL → Credenciales de API SUNAT):
  environment: 'production',
  gre: { clientId: process.env.GRE_CLIENT_ID!, clientSecret: process.env.GRE_CLIENT_SECRET! },
  // …
});

const prepared = client.prepareDespatch({
  series: 'T001',
  number: 1,
  reason: '01', // catálogo 20: 01 venta, 04 traslado entre establecimientos, 13 otros…
  recipient: { docType: '6', docNumber: '20131312955', name: 'CLIENTE SAC' },
  transportMode: 'private', // 'private' = vehículo propio · 'public' = transportista de terceros
  transferStartDate: '2026-11-02', // inicio del traslado (privado) o entrega al transportista (público)
  grossWeight: { value: 425.5, unit: 'KGM' },
  origin: { ubigeo: '040106', address: 'MI ALMACEN' },
  destination: { ubigeo: '040101', address: 'OBRA DEL CLIENTE' },
  vehicle: { plate: 'ABC-123' },
  drivers: [{ docNumber: '12345678', firstName: 'JUAN', lastName: 'PEREZ', license: 'Q12345678' }],
  items: [{ description: 'CEMENTO SOL TIPO I 42.5 KG', quantity: 10 }],
  relatedDocuments: [{ type: '01', number: 'F001-123' }], // factura que sustenta la venta
});
console.log(prepared.summary, prepared.warnings); // para confirmar con el usuario

const result = await client.sendDespatch(prepared);
// 'accepted' | 'accepted_with_observations' | 'rejected' | 'pending' (usa getDespatchStatus({ baseName, ticket }))
```

Una vez que SUNAT entrega el ticket, `sendDespatch` ya no lanza errores: si la consulta del resultado falla (red, 5xx,
CDR ilegible) devuelve `pending` con el `ticket` y el motivo en `statusError`. Guarda ese ticket y consulta luego con
`getDespatchStatus`; **no reenvíes la guía**, porque SUNAT ya la recibió. Los fallos pasajeros se reintentan solos
mientras dure la espera (`maxWaitMs`).

#### QR y PDF oficial de la guía

El CDR de una GRE aceptada trae `cdr.qrUrl`: una URL de SUNAT que es **exactamente el texto que debe codificar el QR**
(la RS 000123-2022/SUNAT dice que el contribuyente genera el QR "a partir de la información proporcionada por la SUNAT
en el CDR"). Esa misma URL entrega el **PDF oficial** de la guía, así que no hace falta armar un PDF propio:

```ts
// Recomendado: pide el PDF al emitir y guárdalo junto al XML y al CDR.
const sent = await client.sendDespatch(prepared, { downloadPdf: true });
if (sent.status === 'accepted' || sent.status === 'accepted_with_observations') {
  save(sent.cdrZip); // el CDR es el sustento del traslado
  if (sent.pdf)
    save(sent.pdf.pdf, sent.pdf.fileName); // PDF oficial (Uint8Array)
  else console.warn(sent.pdfError); // la guía quedó aceptada; reintenta luego con downloadDespatchPdf(sent.cdr.qrUrl)
  const qrText = sent.cdr.qrUrl; // codifícalo en un QR con la librería de tu app (el SDK no dibuja el QR)
}
```

`downloadPdf` nunca convierte un fallo de descarga en un error del envío. También puedes bajar el PDF más tarde con
`client.downloadDespatchPdf(cdr.qrUrl)`.

- Al escanear el QR, el teléfono **descarga** el PDF (la URL responde con un archivo, no con una página). Verificado con
  una guía real de SOL y una emitida por este SDK.
- `downloadDespatchPdf` solo acepta URLs `https` de `*.sunat.gob.pe`, comprueba que el contenido sea un PDF y reintenta
  ante fallos de red o errores 5xx. No necesita credenciales.
- Guarda el PDF y el CDR al emitir: ese servicio de SUNAT es **intermitente** (el 2026-11-01 respondió en menos de 1 s
  y luego se colgó en varias peticiones seguidas; responde con un encabezado de ambiente de desarrollo). La
  representación impresa de SUNAT no tiene valor tributario: el sustento es el XML y su CDR.
- El QR (o, si no se lleva, decir el RUC, la serie y el número al fiscalizador) es lo que sustenta el traslado según la
  RS 000123-2022/SUNAT; el PDF es solo una copia legible. La app debe poder mostrar el QR aunque el PDF no se haya bajado.
- El botón "Descargar representación" de la consulta de GRE en SOL puede aparecer deshabilitado para guías emitidas por
  API; la URL del QR sí funciona.

#### Consultar una factura ya informada (`getStatusCdr`)

```ts
const status = await client.getInvoiceStatus({ series: 'F001', number: 15 });
// { statusCode, statusMessage, cdr?, cdrZip? }  (el código se devuelve tal cual lo entrega SUNAT)
```

Es de **solo lectura** y solo existe en **producción** (SUNAT no publica el servicio de consulta en beta). Sirve para
saber qué pasó con un envío que terminó en error de red antes de reenviarlo, para recuperar un CDR perdido y para
comprobar en producción que el usuario SOL y sus permisos funcionan sin crear nada
(`scripts/invoice-prod-check.ts`). El manual del programador no lista la tabla de códigos de este método, así que el SDK
no los interpreta: un comprobante inexistente puede llegar como código o como excepción (`SunatFaultError`).

#### Consultar los datos de un contribuyente por su RUC (`consultRuc`)

Va en una entrada aparte, `@alonso804/sunat-sdk/ruc`, separada de `SunatClient`: una app que solo emite comprobantes
no la carga, y una falla en la consulta no afecta la emisión.

```ts
import { consultRuc, RucConsultStatus } from '@alonso804/sunat-sdk/ruc';
import { SunatApiError } from '@alonso804/sunat-sdk'; // los errores son las clases de la entrada principal

const result = await consultRuc('20539579356');
if (result.status === RucConsultStatus.found) {
  result.legalName; // "EMPRESA DE TRANSPORTES PERU BUS KLEY S.A.C." (razón social)
  result.tradeName; // Nombre comercial (si está registrado)
  result.taxpayerStatus; // Estado del contribuyente: ACTIVO, BAJA DE OFICIO…
  result.taxpayerCondition; // Condición del contribuyente: HABIDO, NO HABIDO…
  result.fiscalAddress; // Domicilio fiscal
  result.mainActivity; // { code: '4921', description: 'TRANSPORTE …' } (CIIU Rev. 4, la actividad principal)
}
```

Es de **solo lectura** y **no necesita certificado ni credenciales**: hace el mismo POST que el formulario web de
`e-consultaruc.sunat.gob.pe` (`cl-ti-itmrconsruc/jcrS00Alias`) y se interpreta la página HTML que responde. Opciones:
`consultRuc(ruc, { fetch, timeoutMs, retry: { maxRetries, delayMs } })`.

- Como los demás resultados del SDK, se distingue por `status`: `'found'` con los datos, o `'not_found'` cuando la
  consulta no informa datos. `not_found` pasa con RUC inexistentes y también cuando SUNAT está saturada
  (por eso no se interpreta como "no existe" a la primera). Los demás fallos (red, página rara, otro RUC) son errores
  del SDK; los primeros dos se reintentan solos (opción `retry`, igual que en `SunatClient`).
- El RUC se valida antes de consultar (`isValidRuc`); un RUC inválido lanza `SunatValidationError` sin contactar a SUNAT.
- El formulario pide el token del reCAPTCHA: al 02/11/2026 SUNAT no lo validaba (se envía texto aleatorio de 52
  caracteres, sin cookies); tu script de referencia (`consulta_sunat.py`) sigue pasando con token aleatorio.
- ⚠️ **Anti-bot** (revisado el 04/11/2026): SUNAT tiene este dominio detrás de Cloudflare. Puntúa al cliente por su
  huella TLS/HTTP: el `urllib` de Python y el **`curl` del sistema en Windows (Schannel) pasan**, mientras el TLS
  de Node (`fetch`, `https`, `http2`) recibe el desafío `403` ("Just a moment…", `cf-mitigated: challenge`) — y
  también lo reciben las cabeceras con nombres en minúscula, por eso el transporte deja los nombres estilo
  navegador (Title-Case). El SDK lo resuelve solo:
  - **Fallback automático** (por defecto): `consultRuc` consulta con el `fetch` de Node y, solo si llega el
    desafío, reintenta una vez con el curl del sistema (queda deshabilitado si el SO no tiene curl, o si pasas tu
    propio `fetch`). Se apaga con `curlFallback: false`. Verificado en producción el 04/11/2026.
  - **A mano** (para forzar curl desde la primera consulta): `consultRuc(ruc, { fetch: curlFetch() })`.
  - **Cookies de navegador** que ya superó el desafío: **probado el 04/11/2026 y no bastan desde Node** — con un
    `cf_clearance` fresco del navegador el desafío siguió llegando, con y sin `User-Agent` de navegador: Cloudflare
    ata el desafío (y su clearance) a la huella del cliente (IP + TLS/HTTP), no a la cookie en solitario. Útiles
    solo desde un cliente cuya huella ya pasa el score.
- **¿El fallback necesita instalar algo?** Nada por defecto: `curl` viene integrado en Windows 10/11 (System32) y
  en macOS (`/usr/bin/curl`). En servidores Linux suele faltar solo en imágenes contenedorizadas
  (`apt install curl` / `apk add curl` / `dnf install curl`, según la base). El SDK lo comprueba una vez
  (`isCurlAvailable()`); si falta, sigue en pie el error del desafío con las cookies como vía sin instalar nada.
  Nota por plataforma: el curl de Windows lleva Schannel (huella que pasa); el de macOS/Linux lleva
  OpenSSL/LibreSSL — es distinta de la de Node y probable que pase (igual que `urllib` de Python), pero sin
  verificar sobre esas plataformas: pruébalo ahí con `scripts/ruc-consult.ts`; si devolviera el desafío,
  queda el error claro (`SunatApiError` código `desafio-antibot`) y las cookies. Cuando SUNAT retire el desafío,
  el `fetch` de Node vuelve a servir solo, sin curl ni cookies.
- El parseo depende de la página de SUNAT (estructura Bootstrap de "list-group" confirmada el 04/11/2026); si
  cambia y deja de extraer bien, corre `pnpm tsx scripts/ruc-consult.ts <RUC> --dump` y revisa el HTML guardado
  en `out/` para calibrar `src/ruc-consult/parse.ts`.

#### Reintentos automáticos

`SunatClient` reintenta solo los fallos pasajeros: 3 reintentos por defecto, con pausas de 1 s, 2 s y 4 s.

```ts
new SunatClient({ /* … */ retry: { maxRetries: 3, delayMs: 1000 } }); // `{ maxRetries: 0 }` los desactiva
```

| Llamada                                                             | Se reintenta si…                                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sendInvoice`, `sendDespatch` (envíos)                              | SUNAT **con seguridad no procesó** la petición: el proxy respondió `401` (peticiones muy seguidas), `429` o `503`, o la conexión no llegó a abrirse (DNS, conexión rechazada). |
| Token de la API, `getInvoiceStatus`, `getDespatchStatus` (lecturas) | cualquier fallo pasajero: red, espera agotada, `408`, `429`, `5xx`.                                                                                                            |

Un envío **no** se reintenta si la petición pudo haber llegado (corte a mitad, espera agotada, `500`, `502`, `504`):
SUNAT pudo haberla procesado, así que el error llega a tu código para que consultes el estado (`getInvoiceStatus`)
antes de reenviar. Tampoco se reintentan las respuestas de SUNAT (rechazos, excepciones, credenciales incorrectas).
Si un error llega hasta tu código es porque persistió tras los reintentos o porque reintentar no era seguro.

El paquete corre en **Node** (firma, SOAP y REST necesitan secretos y `crypto`); la app móvil/desktop debe llamarlo
a través de un backend, nunca firmar en el dispositivo.

## Reglas de SUNAT que conviene tener presentes

Verificadas contra el manual del programador de SUNAT y contra el ambiente beta:

- **Un rechazo (códigos 2000–3999) consume el correlativo** de facturas y notas: no se puede reutilizar,
  hay que emitir otro número. Una **excepción** (0100–1999, p. ej. `1036`) deja el documento "no informado"
  y se puede reenviar con el mismo número. El SDK distingue ambos (`status: 'rejected'` vs `SunatFaultError.kind`).
- **Si falla la red no se sabe si SUNAT recibió el comprobante**: no generes otro correlativo; reenvía el mismo
  o consulta su estado.
- **Beta valida** estructura (XSD), firma y cálculos (`3291` si el IGV no cuadra), pero **no valida la clave SOL
  ni las fechas**. Un resultado "aceptada" en beta no garantiza aceptación en producción.
- **No envíes peticiones muy seguidas o en paralelo**: el proxy de SUNAT responde `401` (`SunatTransportError.retryable`).
  El cliente ya reintenta ese caso solo, con tope (ver [Reintentos automáticos](#reintentos-automáticos)).
- La firma usa **RSA-SHA1/SHA1** por defecto (lo que documenta SUNAT). `sha256` está disponible
  (`signatureAlgorithm: 'sha256'`); beta acepta ambos. En producción, las guías (GRE) se aceptan con SHA1, el valor
  por defecto (`scripts/gre-prod-check.ts`); para facturas falta confirmarlo.
- **Tildes y caracteres especiales:** SUNAT beta aceptó, sin observaciones, facturas con tildes, ñ, símbolos (½ ° « » ¿ ¡)
  y caracteres fuera de Latin-1 (€ “ ” — Ω) en descripciones, nombre del cliente y nota (verificado el 04/11/2026). El SDK
  los envía tal cual (XML en UTF-8). Si un PDF que arma SUNAT (el de SOL, o el oficial de la guía) muestra `?`, usa
  `textCharset: TextCharset.latin1`: cambia los caracteres fuera de Latin-1 por equivalentes simples (“ ” → ", — → -,
  € → EUR) y quita los que no tienen equivalente, antes de firmar. Las tildes y la ñ no cambian.
- Precio: se calcula valor unitario = precio con IGV / 1.18 (10 decimales), valor de línea = cantidad × valor unitario
  (2 decimales) e IGV por línea. Con este criterio, SUNAT beta aceptó 40 de 40 facturas aleatorias.

### Guías de remisión (RS 000123-2022/SUNAT)

Verificadas contra el texto de la resolución y sus anexos 12 y 14 (campos, condiciones y estándar UBL 2.1):

- **No hay ambiente de pruebas para la GRE.** Las pruebas reales son en producción: ver `scripts/gre-prod-check.ts`.
  Por eso, con `environment` distinto de `production`, `sendDespatch` y `getDespatchStatus` fallan sin contactar a
  nadie (salvo que indiques `gre.apiEndpoint` y `gre.authEndpoint` de un simulador): un cliente de pruebas nunca
  emite guías reales.
- **Antes de iniciar el traslado hay que tener el CDR con estado "aceptada"** (art. 34); el traslado solo se sustenta con él.
- **La baja existe** (art. 8): el remitente puede dar de baja la GRE **en SOL** mientras el traslado no haya iniciado
  (o si cambia el destinatario durante el traslado). Por eso las pruebas usan una fecha de inicio futura.
- **El destinatario con RUC distinto del remitente recibe un aviso en su Buzón SOL** y puede declarar su no conformidad
  hasta el 7.º día del mes siguiente (art. 9): nunca se prueba con terceros como destinatario.
- **Serie `T` + 3 caracteres** (anexo 12), correlativo de 1 a 99 999 999, independiente del de las guías impresas. El sistema
  valida que la numeración no se haya usado antes. El portal SOL emite con series `EG##`, así que un sistema propio
  (`T001`…) no choca con él.
- En los motivos **02, 04 y 07 el destinatario es el propio remitente**; el **04** exige los códigos de establecimiento de
  partida y llegada; el **13** exige describir el motivo; el **03** exige comprador. Transporte **privado**: placa y
  conductor (con licencia). **Público**: RUC y nombre del transportista.
- API REST: el envío devuelve un ticket y SUNAT procesa de forma asíncrona (`98` en proceso, `0` correcto, `99` con errores).
  Un rechazo de guía **no** invalida el número (a diferencia de las facturas).

## Distribución

Plan por etapas (el paquete no depende de cómo viva el repositorio):

1. **Desarrollo: enlace local.** En el proyecto que lo consume:

   ```bash
   pnpm add link:../sunat-sdk   # crea "@alonso804/sunat-sdk": "link:../sunat-sdk"
   ```

   y en este repo `pnpm dev` (tsup en modo watch) para que `dist/` se mantenga al día.
2. **Servidor / CI: GitHub Packages (privado).** El paquete se llama `@alonso804/sunat-sdk` (GitHub exige que el scope
   sea el del dueño). El nombre sin scope `sunat-sdk` **ya existe en el npm público** (otro autor): no se puede publicar
   ahí y, desde un registro sin scope, un proyecto podría instalar el paquete equivocado. `package.json` ya lleva
   `publishConfig.registry = https://npm.pkg.github.com` y `access: restricted`, así que nunca sube al npm público.
   - **Publicar (automático, workflow `Release`)**: sube `version` en `package.json` en una rama, fusiónala a `main`
     por PR y, desde `main` actualizado, sube una etiqueta con esa versión:
     `git tag -s v0.2.0 -m v0.2.0 && git push origin v0.2.0`. El workflow comprueba que
     la etiqueta coincida con `package.json` y esté en `main`, corre Biome, typecheck, pruebas y build, y publica con
     `npm publish --ignore-scripts` usando el token del propio workflow, que solo existe en ese último paso: no hace
     falta ningún token personal. Si GitHub lo rechaza con
     403, en la página del paquete → _Package settings_ → **Manage Actions access**, agrega este repositorio con rol
     _Write_.
   - **Publicar a mano (alternativa)**: así se publicó la 0.1.0. Agrega el permiso con
     `gh auth refresh -h github.com -s write:packages,read:packages`, publica con `npm publish` usando un
     `.npmrc` temporal con `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` y
     `NODE_AUTH_TOKEN=$(gh auth token)`, y quita el permiso después con
     `gh auth refresh -h github.com -r write:packages,read:packages`.
   - **Consumir**: en el proyecto de la app, un `.npmrc` con `@alonso804:registry=https://npm.pkg.github.com` y
     `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` (PAT _classic_ con `read:packages`; el `.npmrc` sí
     puede ir en git, el token no). No uses el nombre `GITHUB_TOKEN` en tu máquina: si existe, `gh` lo usa en
     lugar de tus cuentas.
   - **CI**: cada push corre el workflow `CI` (Biome, typecheck, pruebas y build) en una máquina limpia con
     Linux; las pruebas contra SUNAT beta no corren ahí.
   - **`main` solo por PR**: GitHub Free no permite proteger ramas en repositorios privados, así que hay dos controles
     en su lugar. El hook `.githooks/pre-push` rechaza en tu máquina el push directo a `main` (actívalo una vez por clon
     con `git config core.hooksPath .githooks`; `--no-verify` lo salta). El workflow `Main por PR` no lo impide en
     GitHub, pero falla y te avisa si a `main` llega un commit que no salió de un PR fusionado, o un push forzado.
     Además, Actions exige que toda acción esté fijada por SHA (opción del repositorio).
3. **Plan B: monorepo.** Mover esta carpeta a `packages/sunat-sdk` y consumirla con `"@alonso804/sunat-sdk": "workspace:*"`
   (sin registro ni tokens).

## Antes de pasar a producción (trámites en SOL, los hace el titular)

1. **Certificado Digital Tributario** (gratuito; máximo 2 en la vida, 3 años de vigencia, solo para firmar comprobantes
   del titular). SOL → Empresas → Comprobantes de pago → Certificado Digital Tributario - CDT → Solicitar. El enlace de
   descarga llega al Buzón SOL ("Emisión del Certificado Digital Tributario"); ahí se define la contraseña de la clave privada.
2. **Credenciales de API** para guías: SOL → Credenciales de API SUNAT → HABILITAR → registrar nombre y URL de la aplicación.
3. **Usuario SOL secundario** con permiso solo para comprobantes y guías (SOL → Administración Usuarios → Crear Usuario).
4. Facturas: según la RS 287-2017/SUNAT ya **no hay solicitud de autorización ni homologación**; basta marcar
   "SEE - Del Contribuyente" y registrar el correo y el certificado en SOL (SOL → Comprobantes de pago →
   "SEE - Del Contribuyente y Envío de Documentos" → Certificado Digital). Puede emitir desde el día calendario siguiente.
5. Series propias para el sistema (las del portal no se comparten): facturas `F` + 3 caracteres (p. ej. `F001`).

## Scripts

| Comando                                                                   | Qué hace                                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                                               | pruebas unitarias (sin red)                                                                                                               |
| `pnpm check`                                                              | Biome: formato, linter y orden de imports (no modifica nada; también corre antes de publicar)                                             |
| `pnpm check:fix`                                                          | Biome: aplica el formato, el orden de imports y los arreglos seguros del linter                                                           |
| `pnpm test:beta`                                                          | pruebas contra SUNAT beta (red, sin efecto tributario)                                                                                    |
| `pnpm tsx scripts/beta-smoke.ts`                                          | envía una factura de prueba a beta                                                                                                        |
| `pnpm tsx scripts/beta-faults.ts [a b c d e ok]`                          | envía XML defectuosos a propósito para ver errores reales                                                                                 |
| `pnpm tsx scripts/beta-matrix.ts 25 7`                                    | lote de facturas aleatorias (cantidad, semilla)                                                                                           |
| `pnpm tsx --env-file=.env scripts/inspect-cert.ts`                        | revisa tu `.p12` (titular, vigencia, llave) y prueba firmar; no envía nada                                                                |
| `pnpm tsx --env-file=.env scripts/gre-prod-check.ts plan`                 | guía de prueba sin red: arma, firma y valida contra el XSD                                                                                |
| `… gre-prod-check.ts auth`                                                | solo pide el token (no crea documentos)                                                                                                   |
| `… gre-prod-check.ts negative`                                            | envía a producción una guía **alterada** que SUNAT debe rechazar; pide confirmación escrita (si la aceptara, dar de baja en SOL)          |
| `… gre-prod-check.ts positive`                                            | emite **una** guía de prueba REAL con confirmación escrita (dar de baja en SOL)                                                           |
| `pnpm tsx --env-file=.env scripts/invoice-prod-check.ts [serie] [número]` | consulta de **solo lectura** (`getStatusCdr`): prueba usuario, clave y permiso de consulta en producción                                  |
| `… invoice-prod-send.ts out/factura.json plan`                            | factura sin red: valida, calcula, firma y muestra el resumen (ver `scripts/examples/invoice.example.json`)                                |
| `… invoice-prod-send.ts out/factura.json status`                          | solo lectura: ¿ya existe esa serie y número en SUNAT? (úsalo tras un error de red)                                                        |
| `… invoice-prod-send.ts out/factura.json send`                            | emite **una factura REAL**: comprueba que el número esté libre y pide escribir `ENVIAR <nombre>`                                          |
| `pnpm tsx scripts/ruc-consult.ts <RUC…> [--dump]`                         | consulta pública (sin credenciales) de los datos publicados de uno o varios RUC, vía curl; con `--dump` guarda el HTML devuelto en `out/` |
| `pnpm build`                                                              | genera `dist/` (ESM, CJS y tipos)                                                                                                         |

## Seguridad

- Nunca versionar certificados (`.pfx`, `.pem`) ni credenciales: el `.gitignore` ya los excluye.
- La librería no lee variables de entorno ni guarda secretos; quien la use decide dónde viven.
