import { SunatValidationError } from '../errors';
import { D, dec, fmt2, round, type Dec } from '../money';
import type { Invoice } from './schema';

export type ResolvedPayment =
  | { type: 'cash' }
  | {
      type: 'credit';
      /** Monto neto pendiente de pago (por defecto, el total de la factura). */
      netPending: Dec;
      installments: Array<{ number: number; dueDate: string; amount: Dec }>;
    };

const CENT = new D('0.01');

/**
 * Completa y valida la forma de pago con el total ya calculado de la factura.
 *
 * - Monto neto pendiente: si no se indica, es el total. No puede ser mayor al total (regla de SOL y de SUNAT, 3265).
 * - Fechas: cada vencimiento debe ser POSTERIOR a la fecha de emisión (SUNAT rechaza con 3267 una fecha anterior o igual).
 *   No importa el orden de las cuotas (SUNAT acepta fechas desordenadas).
 * - Cuotas: si ninguna trae monto, se reparte el monto neto pendiente en partes iguales y la diferencia de centavos
 *   va en la última; si todas lo traen, deben sumar exactamente el monto neto pendiente (SUNAT rechaza con 3319 si no suman). No se admiten mezclas.
 */
export function resolvePayment(payment: Invoice['payment'], total: Dec, issueDate: string): ResolvedPayment {
  if (payment.type === 'cash') return { type: 'cash' };

  const issues: Array<{ path: string; message: string }> = [];
  const totalCents = round(total, 2);
  const netPending = payment.netPending === undefined ? totalCents : round(dec(payment.netPending), 2);

  if (netPending.gt(totalCents)) {
    issues.push({ path: 'payment.netPending', message: `El monto neto pendiente (${fmt2(netPending)}) no puede ser mayor al importe total (${fmt2(totalCents)})` });
  }

  const count = payment.installments.length;
  const withAmount = payment.installments.filter((i) => i.amount !== undefined).length;
  let amounts: Dec[] = [];
  if (withAmount === 0) {
    const base = netPending.div(count).toDecimalPlaces(2, D.ROUND_DOWN);
    amounts = payment.installments.map(() => base);
    const remainder = netPending.minus(base.times(count));
    amounts[count - 1] = base.plus(remainder);
  } else if (withAmount === count) {
    amounts = payment.installments.map((i) => round(dec(i.amount as number | string), 2));
    const sum = amounts.reduce((acc, a) => acc.plus(a), new D(0));
    if (!sum.minus(netPending).abs().lt(CENT)) {
      issues.push({ path: 'payment.installments', message: `Las cuotas suman ${fmt2(sum)} y deben sumar el monto neto pendiente (${fmt2(netPending)})` });
    }
  } else {
    issues.push({ path: 'payment.installments', message: 'Indica el monto en todas las cuotas o en ninguna (así se reparte en partes iguales)' });
  }

  payment.installments.forEach((installment, i) => {
    if (installment.dueDate <= issueDate) {
      issues.push({ path: `payment.installments.${i}.dueDate`, message: `El vencimiento (${installment.dueDate}) debe ser posterior a la fecha de emisión (${issueDate})` });
    }
  });

  if (issues.length > 0) throw new SunatValidationError('La forma de pago no es válida.', issues);
  return {
    type: 'credit',
    netPending,
    installments: payment.installments.map((installment, i) => ({ number: i + 1, dueDate: installment.dueDate, amount: amounts[i] as Dec })),
  };
}
