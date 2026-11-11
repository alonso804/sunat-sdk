# Política de seguridad

Este SDK firma comprobantes con certificados digitales y maneja credenciales SOL, así que los reportes de seguridad
se toman en serio.

## Cómo reportar una vulnerabilidad

**No abras un issue público.** Usa el reporte privado de GitHub:
[Security → Report a vulnerability](https://github.com/alonso804/sunat-sdk/security/advisories/new).

Incluye, si puedes: la versión afectada, los pasos para reproducirlo y el impacto que ves. Responderé lo antes posible.

## Qué NO subir nunca (ni en issues ni en PR)

Certificados (`.pfx`/`.p12`), llaves privadas, Clave SOL, `client_secret` de la API, ni XML/CDR reales con datos de
clientes. Si publicaste algo así por accidente, revócalo o cámbialo de inmediato.

## Versiones soportadas

Solo la última versión publicada.
