# Esquemas XSD de UBL 2.1

Copia sin modificar de los esquemas de **OASIS Universal Business Language (UBL) 2.1**
(<http://docs.oasis-open.org/ubl/os-UBL-2.1/>), usados solo en pruebas para validar localmente
el XML de facturas (`Invoice`) y guías de remisión (`DespatchAdvice`), igual que lo hace el servicio de SUNAT.

Cada archivo conserva su aviso de derechos: "Copyright (c) OASIS Open 2013. All Rights Reserved."
Se incluyen únicamente `maindoc/UBL-Invoice-2.1.xsd`, `maindoc/UBL-DespatchAdvice-2.1.xsd` y la carpeta `common/`
(dependencias de ambos).

La validación usa `xmllint-wasm` (libxml2 compilado a WebAssembly, dependencia de desarrollo): no hace falta instalar
`xmllint` en el sistema, así que las pruebas de esquema corren igual en Windows, macOS, Linux y CI.
