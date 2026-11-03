import type { ZodError } from 'zod';
import { SunatValidationError } from './errors';

/** Convierte los errores de zod en un SunatValidationError con mensaje y detalle por campo. */
export function toValidationError(error: ZodError): SunatValidationError {
  const issues = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  const detail = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
  return new SunatValidationError(`Datos inválidos: ${detail}`, issues);
}
