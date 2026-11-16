import { Currency, DETRACTION } from '../catalogs';
import { SunatValidationError } from '../errors';
import { D, type Dec, dec, fmt2, round } from '../money';
import type { Invoice } from './schema';

export type ResolvedDetraction = {
  account: string;
  /** Monto en soles. */
  amount: Dec;
};

const PERCENT = new D(DETRACTION.percent).div(100);
const TOLERANCE = new D(1);

/**
 * Valida la detracción contra el total ya calculado y completa el monto (12 % del total) si no se indicó.
 * Con detracción, el tipo de operación es 1001: SUNAT rechaza (3128) un bloque de detracción con otro tipo y (3127/3034)
 * un 1001 sin código de servicio o sin cuenta. Una factura en otra moneda exige el monto en soles.
 */
export function resolveDetraction(invoice: Invoice, total: Dec): ResolvedDetraction | undefined {
  const { detraction } = invoice;
  if (!detraction) return undefined;

  const issues: Array<{ path: string; message: string }> = [];
  if (invoice.operationType !== '0101' && invoice.operationType !== DETRACTION.operationType) {
    issues.push({
      path: 'operationType',
      message: `Una factura con detracción se emite con el tipo de operación ${DETRACTION.operationType}; no la combines con ${invoice.operationType}`,
    });
  }

  const expected = round(total.mul(PERCENT), 2);
  let amount: Dec | undefined;
  if (detraction.amount !== undefined) {
    amount = round(dec(detraction.amount), 2);
    if (invoice.currency === Currency.PEN && amount.minus(expected).abs().gt(TOLERANCE)) {
      issues.push({
        path: 'detraction.amount',
        message: `El monto (${fmt2(amount)}) debe estar a menos de S/ 1 del ${DETRACTION.percent} % del total (${fmt2(expected)})`,
      });
    }
    if (amount.gt(round(total, 2)) && invoice.currency === Currency.PEN) {
      issues.push({ path: 'detraction.amount', message: 'El monto de la detracción no puede ser mayor al total' });
    }
  } else if (invoice.currency === Currency.PEN) {
    amount = expected;
  } else {
    issues.push({
      path: 'detraction.amount',
      message: 'En una factura que no es en soles indica el monto de la detracción en soles',
    });
  }

  if (issues.length > 0) throw new SunatValidationError('La detracción no es válida.', issues);
  return { account: detraction.account, amount: amount as Dec };
}
