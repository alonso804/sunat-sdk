# sunat-sdk

SDK en TypeScript para emitir comprobantes electrónicos **directo a SUNAT** (sin PSE ni OSE),
pensado para usarse como paquete privado desde otras aplicaciones (desktop / móvil vía un backend Node).

> **Estado: en construcción.** La **factura electrónica (01) al contado** funciona contra el ambiente **beta**.
> La **guía de remisión del remitente (GRE 09)** está implementada y validada contra el esquema UBL 2.1,
> pero **aún no se ha probado contra SUNAT** (no existe ambiente de pruebas para la GRE).
> Nada se ha probado todavía en homologación ni producción.

| Capacidad | Estado |
|---|---|
| Factura 01, contado, PEN/USD, gravado/exonerado/inafecto | ✅ aceptada por SUNAT beta (40 de 40 en pruebas aleatorias) |
| Firma XMLDSig, ZIP, SOAP `sendBill`, lectura del CDR | ✅ |
| Resumen para confirmar antes de emitir (`prepareInvoice`, `prepareDespatch`) | ✅ |
| GRE remitente: XML UBL 2.1 + firma + API REST (token OAuth, ticket, CDR) | ✅ implementada y validada con el XSD oficial · ⚠️ sin probar contra SUNAT |
| Validación local contra los XSD de UBL 2.1 (`xmllint`) | ✅ facturas y 4 variantes de GRE |
| Factura a crédito (cuotas), descuentos, anticipos, detracción | ⏳ |
| Notas de crédito / débito, boletas | ⏳ |
| Consulta de estado / CDR de facturas (`getStatusCdr`) | ⏳ |
| GRE transportista, motivos de importación/exportación, baja de GRE por API | ⏳ |
| Lectura de comprobantes y guías emitidos (SIRE y otros) | ⏳ |
| Generación de PDF / QR | ⏳ |

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
// result.status: 'accepted' | 'accepted_with_observations' | 'rejected'
```

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
prepared.summary.total;   // "14.16": ya disponible para mostrarlo mientras eliges las cuotas
prepared.summary.payment; // { type: 'credit', netPending: '14.16', installments: [{ number: 1, dueDate, amount: '7.08' }, …] }
```

Reglas verificadas contra el servicio de **beta** de SUNAT (el SDK las valida antes de enviar, porque un rechazo de una
factura consume el correlativo):

| Regla | Código de SUNAT |
|---|---|
| Las cuotas deben sumar el monto neto pendiente | 3319 |
| El monto neto pendiente no puede ser mayor al importe total (sí puede ser menor) | 3265 |
| El vencimiento de cada cuota debe ser **posterior** a la fecha de emisión (no igual) | 3267 |
| Máximo 60 cuotas (límite de SOL) | — |
| El orden de las cuotas no importa (SUNAT acepta fechas desordenadas) | — |

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

#### QR y PDF oficial de la guía

El CDR de una GRE aceptada trae `cdr.qrUrl`: una URL de SUNAT que es **exactamente el texto que debe codificar el QR**
(la RS 000123-2022/SUNAT dice que el contribuyente genera el QR "a partir de la información proporcionada por la SUNAT
en el CDR"). Esa misma URL entrega el **PDF oficial** de la guía, así que no hace falta armar un PDF propio:

```ts
// Recomendado: pide el PDF al emitir y guárdalo junto al XML y al CDR.
const sent = await client.sendDespatch(prepared, { downloadPdf: true });
if (sent.status === 'accepted' || sent.status === 'accepted_with_observations') {
  save(sent.cdrZip); // el CDR es el sustento del traslado
  if (sent.pdf) save(sent.pdf.pdf, sent.pdf.fileName); // PDF oficial (Uint8Array)
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
- La firma usa **RSA-SHA1/SHA1** por defecto (lo que documenta SUNAT). `sha256` está disponible
  (`signatureAlgorithm: 'sha256'`); beta acepta ambos, pero hay que confirmar qué exige producción.
- Precio: se calcula valor unitario = precio con IGV / 1.18 (10 decimales), valor de línea = cantidad × valor unitario
  (2 decimales) e IGV por línea. Con este criterio, SUNAT beta aceptó 40 de 40 facturas aleatorias.

### Guías de remisión (RS 000123-2022/SUNAT)

Verificadas contra el texto de la resolución y sus anexos 12 y 14 (campos, condiciones y estándar UBL 2.1):

- **No hay ambiente de pruebas para la GRE.** Las pruebas reales son en producción: ver `scripts/gre-prod-check.ts`.
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
   - **Publicar** (una vez por versión; antes se corre `pnpm prepublishOnly`, que hace typecheck, pruebas y build):
     `pnpm publish`. Requiere en tu `~/.npmrc` (fuera del repo) la línea
     `//npm.pkg.github.com/:_authToken=<PAT classic con write:packages>`. *(Aún no se ha publicado ninguna versión: este
     procedimiento sigue la documentación de GitHub y falta comprobarlo.)*
   - **Consumir**: en el proyecto de la app, un `.npmrc` con `@alonso804:registry=https://npm.pkg.github.com` y
     `//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}` (PAT *classic* con `read:packages`; no se sube a git).
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

| Comando | Qué hace |
|---|---|
| `pnpm test` | pruebas unitarias (sin red) |
| `pnpm test:beta` | pruebas contra SUNAT beta (red, sin efecto tributario) |
| `pnpm tsx scripts/beta-smoke.ts` | envía una factura de prueba a beta |
| `pnpm tsx scripts/beta-faults.ts [a b c d e ok]` | envía XML defectuosos a propósito para ver errores reales |
| `pnpm tsx scripts/beta-matrix.ts 25 7` | lote de facturas aleatorias (cantidad, semilla) |
| `pnpm tsx --env-file=.env scripts/inspect-cert.ts` | revisa tu `.p12` (titular, vigencia, llave) y prueba firmar; no envía nada |
| `pnpm tsx --env-file=.env scripts/gre-prod-check.ts plan` | guía de prueba sin red: arma, firma y valida contra el XSD |
| `… gre-prod-check.ts auth` | solo pide el token (no crea documentos) |
| `… gre-prod-check.ts negative` | envía una guía **alterada** que SUNAT debe rechazar (no deja registro) |
| `… gre-prod-check.ts positive` | emite **una** guía de prueba REAL con confirmación escrita (dar de baja en SOL) |
| `pnpm tsx --env-file=.env scripts/invoice-prod-check.ts [serie] [número]` | consulta de **solo lectura** (`getStatusCdr`): prueba usuario, clave y permiso de consulta en producción |
| `… invoice-prod-send.ts out/factura.json plan` | factura sin red: valida, calcula, firma y muestra el resumen (ver `scripts/examples/invoice.example.json`) |
| `… invoice-prod-send.ts out/factura.json status` | solo lectura: ¿ya existe esa serie y número en SUNAT? (úsalo tras un error de red) |
| `… invoice-prod-send.ts out/factura.json send` | emite **una factura REAL**: comprueba que el número esté libre y pide escribir `ENVIAR <nombre>` |
| `pnpm build` | genera `dist/` (ESM, CJS y tipos) |

## Seguridad

- Nunca versionar certificados (`.pfx`, `.pem`) ni credenciales: el `.gitignore` ya los excluye.
- La librería no lee variables de entorno ni guarda secretos; quien la use decide dónde viven.
