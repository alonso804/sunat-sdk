# Cómo obtener las variables de SUNAT (API y usuario secundario)

Guía de lo que se hizo en SOL el 2026-11-01. Lo marcado **(verificado)** se hizo y funcionó en esa sesión;
lo marcado **(no verificado)** viene de documentación o de memoria y puede haber cambiado.

> **Regla de oro:** la Clave SOL del titular, la Clave de la API, la clave del usuario secundario y la
> contraseña del certificado van **solo** en el archivo `.env` local (está en `.gitignore`). Nunca en el
> chat, en capturas de pantalla, en el código ni en un repositorio.

## Resumen: de dónde sale cada variable

| Variable del `.env`                | De dónde sale                                                               |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `GRE_CLIENT_ID`                    | SOL → Credenciales de API SUNAT → campo **ID** de la aplicación             |
| `GRE_CLIENT_SECRET`                | SOL → Credenciales de API SUNAT → campo **CLAVE** de la aplicación          |
| `SUNAT_SOL_USER`                   | El usuario secundario que se crea (8 caracteres exactos, ej. `SDKUSR01`)    |
| `SUNAT_SOL_PASSWORD`               | La clave que tú escribes al crear el usuario secundario (8 a 12 caracteres) |
| `SUNAT_RUC`                        | RUC del negocio                                                             |
| `SUNAT_LEGAL_NAME`                 | Razón social tal como figura en la Ficha RUC                                |
| `SUNAT_UBIGEO` y `..._ADDRESS`     | Domicilio fiscal, de la Ficha RUC                                           |
| `SUNAT_CERT_PATH` / `..._PASSWORD` | Certificado Digital Tributario (`.p12`) y su contraseña                     |

Usa `.env.example` como plantilla. Los valores con espacios o símbolos (`#`, `$`, comillas) van entre comillas.

## 1. Credenciales de API (`GRE_CLIENT_ID` y `GRE_CLIENT_SECRET`)

1. Entra a SOL con la **Clave SOL del titular** (RUC + usuario principal).
2. Menú **Empresas → Credenciales de API SUNAT → Gestión Credenciales de API SUNAT**. **(verificado)**
   También aparece en _Favoritos → Últimos accesos_ cuando ya la abriste antes.
3. Si **no hay aplicación**: usa la opción de registrar/habilitar, pon un nombre, una URL cualquiera de tu
   sistema, marca los servicios que necesitas (**GRE Emisión de Comprobantes**, `/v1/contribuyente/gem`;
   para facturas por API REST no hace falta, el SDK usa SOAP) y guarda. **(no verificado: en este negocio ya
   existía una aplicación y no se creó otra)**
4. Si **ya hay una aplicación** (es el caso de este negocio, creada por un proveedor anterior): SOL permite
   **una sola aplicación por RUC** y esa pantalla **no tiene botón de agregar ni de regenerar la Clave**.
   **(verificado)** Se pueden reutilizar su ID y su CLAVE.
5. Copia el **ID** y la **CLAVE** **tú mismo** al `.env`. Esa pantalla muestra ambos valores en texto
   claro: **no tomes capturas de pantalla ni las compartas**.

**Ojo con reutilizar una aplicación de un proveedor:** quien la creó ya conoce esa Clave y su sistema puede
estar usándola. No edites ni borres la aplicación. Si SUNAT habilita la rotación de la Clave, cámbiala antes
de operar en serio. En este negocio el ID y la CLAVE se vieron en capturas de la sesión de trabajo, así que
**conviene rotarlos** cuando sea posible (o pedirlo a SUNAT).

## 2. Usuario SOL secundario (`SUNAT_SOL_USER` y `SUNAT_SOL_PASSWORD`)

Sirve para que el SDK se autentique sin usar la Clave SOL del titular. Se crea con un documento de
identidad (DNI) de una persona real.

1. Entra con la Clave SOL del titular y abre **Administración de Usuarios Secundarios**. Aquí se llegó
   desde un acceso directo; **no la encontré por el buscador del menú ni en "Mi RUC y Otros Registros"**,
   así que si no la ves, búscala como "Acceso directo" o "Administración de usuarios". **(verificado: la
   pantalla existe; la ruta exacta de menú no)**
2. La pantalla muestra los usuarios existentes y tres bloques: **Crear Usuario**, **Modificar Programas /
   Asignar Roles** y **Cambiar Estado** (Suspender o Eliminar).
3. Pulsa **Crear Usuario** → _Registro de Usuario Secundario_:
   - **Tipo y número de documento:** DNI de la persona. Con DNI, SOL completa nombres y apellidos solo.
   - **Correo:** opcional.
   - **Usuario:** **exactamente 8 caracteres** (letras mayúsculas y números, sin símbolos). **(verificado)**
   - **Clave:** de 8 a 12 caracteres. Usa solo letras y números para evitar problemas de lectura en el
     `.env`. Guárdala en el `.env` en el momento.
4. **Siguiente** → _Confirmación de datos_. Revisa y pulsa **Asignar Programas**.
5. En _Asignación de opciones_, despliega **TRIBUTARIOS → Guía de Remisión Electrónica** y marca solo:
   - **Emisión de GRE**
   - **Consulta de GRE**
   - (**Baja de GRE** solo si de verdad quieres ese permiso; no se sabe si la API REST lo usa.)
     No marques _Credenciales de API_, declaraciones, pagos ni nada de Aduaneros o Bienes Fiscalizados.
6. **Siguiente** → _Resumen de asignación_ → **Grabar**. El usuario queda **Activo** y no hizo falta un
   primer ingreso para poder autenticarse. **(verificado)**

**Trampas conocidas:**
- Las pantallas de este módulo **vencen en pocos minutos** ("La vigencia de la invocación ha caducado").
  Haz todo el flujo seguido y no lo dejes abierto mientras haces otra cosa. Si vence, no se guardó nada:
  empieza de nuevo.
- Para **facturas** hará falta, además, el perfil que corresponda al envío de comprobantes (SEE), después de
  la autorización SEE-Del contribuyente. **(no verificado: aún no se ha visto qué opción es)** Se agrega con
  _Modificar Programas_, sin crear otro usuario.
- Para cambiar permisos después: _Administración de Usuarios Secundarios_ → seleccionar el usuario →
  **Modificar Programas**.

## 3. Comprobar que quedó bien (sin crear documentos)

```
fnm exec --using=26 -- pnpm tsx --env-file=.env scripts/gre-prod-check.ts auth
```

Resultado esperado: `Autenticación correcta. El token vence en ~60 min. No se creó ningún documento.`
**(verificado el 2026-11-01)**

El token se pide a `api-seguridad.sunat.gob.pe` con el ID/CLAVE de la aplicación más el usuario
`RUC + usuario secundario` y su clave. Un 401 suele indicar un error en alguno de esos cuatro datos o un
perfil faltante.
