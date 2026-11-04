/**
 * Entrada `@alonso804/sunat-sdk/ruc`: consulta de datos públicos de un contribuyente por su RUC.
 *
 * Va separada de la entrada principal (`SunatClient`, emisión de comprobantes) para que una app que solo emite no
 * cargue este módulo, y para que un cambio o una falla aquí no afecte la emisión. Los errores que lanza son las mismas
 * clases de la entrada principal (`SunatApiError`, `SunatValidationError`…): impórtalas desde `@alonso804/sunat-sdk`.
 */

export type { RucConsultOptions } from './api';
export { consultRuc } from './api';
export { type CurlFetchOptions, curlFetch, isCurlAvailable } from './curl';
export type { RucConsultResult, RucMainActivity } from './parse';
export { RucConsultStatus, RucPageError } from './parse';
