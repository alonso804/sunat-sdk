import { z } from 'zod';
import { dec } from './money';

/** Número decimal positivo escrito como `number` o como `string` ("12.50"). */
export const NumericLike = z.union([
  z.number().finite(),
  z.string().regex(/^\d+(\.\d+)?$/, 'Debe ser un número decimal positivo, por ejemplo "12.50"'),
]);

export const PositiveNumeric = NumericLike.refine((v) => dec(v).gt(0), 'Debe ser mayor que 0');
