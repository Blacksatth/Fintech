import { FieldValue } from "firebase-admin/firestore";
import { DelinquencyStatus, LoanStatus } from "@/server/types";
import type { LoanDoc } from "@/server/credit-doc";
import type { LoanDelinquencyResult } from "@/server/delinquency";

/**
 * Traducción de un recálculo de mora al `update` de `loans` (PROJECT_SPEC §13: "caché en
 * `loans` actualizada por servicios").
 *
 * Vive en `services/` y no en `server/` a propósito: el parche necesita `FieldValue.delete()`
 * (sentinel de `firebase-admin`) y lo que hay en `src/server` es dominio puro, sin Firebase.
 *
 * Lo comparten los dos caminos que recalculan la cartera: la confirmación/reversión de un pago
 * (F10-2b, dentro de la transacción del pago) y el recálculo bajo demanda (F11-1). Con un parche
 * por camino, un cambio de regla en uno dejaría al otro escribiendo una mora que la pantalla
 * contradice.
 */

/** Campos de la caché de mora que el recálculo deja iguales o distintos en `loans`. */
export function loanRecalcPatch(
  recalc: LoanDelinquencyResult,
  loan: Pick<LoanDoc, "status">,
  now: Date,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    delinquencyStatus: recalc.delinquencyStatus,
    daysPastDue: recalc.daysPastDue,
    outstandingPesos: recalc.outstandingPesos,
    updatedAt: now,
  };
  if (recalc.delinquencyStatus === DelinquencyStatus.PAID) {
    patch.status = LoanStatus.PAID;
    patch.paidAt = now;
  } else if (loan.status === LoanStatus.PAID) {
    // Un reverso devolvió la deuda: el préstamo vuelve a estar activo y se borra la fecha de saldado.
    patch.status = LoanStatus.DISBURSED;
    patch.paidAt = FieldValue.delete();
  }
  return patch;
}

/** Estado del préstamo después de aplicar el recálculo (sin tocar el documento todavía). */
export function loanStatusAfterRecalc(
  recalc: Pick<LoanDelinquencyResult, "delinquencyStatus">,
  current: LoanStatus,
): LoanStatus {
  if (recalc.delinquencyStatus === DelinquencyStatus.PAID) return LoanStatus.PAID;
  if (current === LoanStatus.PAID) return LoanStatus.DISBURSED;
  return current;
}

/**
 * ¿La caché de `loans` ya dice lo que dice el recálculo?
 *
 * El recálculo bajo demanda escribe **solo** cuando algo cambió: refrescar la cartera cada vez
 * que un admin abre la pantalla dejaría `updatedAt`-moving en todos los préstamos y un `diff` de
 * la colección tan grande como la cartera, sin que un solo peso haya cambiado.
 */
export function isLoanCacheStale(
  loan: Pick<LoanDoc, "status" | "delinquencyStatus" | "daysPastDue" | "outstandingPesos" | "paidAt">,
  recalc: LoanDelinquencyResult,
): boolean {
  return (
    loan.delinquencyStatus !== recalc.delinquencyStatus ||
    (loan.daysPastDue ?? 0) !== recalc.daysPastDue ||
    (loan.outstandingPesos ?? -1) !== recalc.outstandingPesos ||
    loanStatusAfterRecalc(recalc, loan.status) !== loan.status ||
    (recalc.delinquencyStatus === DelinquencyStatus.PAID && loan.paidAt === undefined)
  );
}
