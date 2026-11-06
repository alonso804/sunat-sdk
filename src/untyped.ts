/**
 * Datos parseados de una respuesta externa (el XML o el JSON que devuelve SUNAT) cuya forma no está tipada: se leen
 * con encadenamiento opcional y cada campo se comprueba al usarlo. El `any` del proyecto se concentra aquí, a propósito.
 */
// biome-ignore lint/suspicious/noExplicitAny: la forma de las respuestas de SUNAT no está tipada; se valida al leerlas.
export type Untyped = Record<string, any>;
