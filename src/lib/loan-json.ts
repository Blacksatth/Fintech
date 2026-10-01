import type { LoanDoc, LoanInstallmentDoc } from "@/server/credit-doc";

type CreditDocDate = LoanDoc["createdAt"];

/**
 * `Date` -> ISO para el JSON de la API.
 *
 * Firestore devuelve `Date` en el Admin SDK, pero el tipo del doc admite `Timestamp`; el
 * cliente nunca debe depender de cuál de los dos llegue.
 */
export function toIso(value: CreditDocDate): string {
  const date = value instanceof Date ? value : new Date(value.toMillis());
  return date.toISOString();
}

export function serializeLoan<T extends LoanDoc>(loan: T & { id: string }) {
  return {
    ...loan,
    createdAt: toIso(loan.createdAt),
    updatedAt: toIso(loan.updatedAt),
  };
}

export function serializeInstallment(cuota: LoanInstallmentDoc & { id: string }) {
  return {
    ...cuota,
    dueDate: toIso(cuota.dueDate),
    ...(cuota.paidAt ? { paidAt: toIso(cuota.paidAt) } : {}),
  };
}

/**
 * Un pago de la lista para el cliente.
 *
 * `reference` solo se incluye si el cliente lo escribió: un `undefined` en el JSON se pierde
 * igual, pero dejarlo explícito evita que un `""` se pinte como si fuera una referencia.
 */
export function serializeListedPayment<T extends { createdAt: Date; reference?: string }>(payment: T) {
  return {
    ...payment,
    createdAt: payment.createdAt.toISOString(),
    ...(payment.reference === undefined || payment.reference === ""
      ? {}
      : { reference: payment.reference }),
  };
}
