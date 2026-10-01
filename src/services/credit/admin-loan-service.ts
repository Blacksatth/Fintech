import { type Firestore } from "firebase-admin/firestore";
import { LoanStatus, type LoanStatus as LoanStatusValue } from "@/server/types";
import type {
  DisbursementDoc,
  LoanDoc,
  LoanInstallmentDoc,
} from "@/server/credit-doc";
import { loanInstallmentDocId } from "@/server/credit-doc";
import type { UserDoc } from "@/server/user-doc";
import { notFound } from "@/lib/errors";

/**
 * Lecturas admin de préstamos. Deliberadamente **separadas** de las de F8-3
 * (`listLoansForUser`/`getLoanForUser`): esas aplican `assertOwnedBy` porque el endpoint es
 * del cliente. Un admin sí puede ver préstamos de otros, y mezclar ambos caminos en un mismo
 * servicio haría fácilsaltarse la autorización por un refactor.
 */

export interface AdminLoanDeps {
  db: Firestore;
}

export interface AdminLoanItem extends LoanDoc {
  id: string;
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value !== null && "toMillis" in value) {
    return (value as { toMillis(): number }).toMillis();
  }
  if (typeof value === "number") return value;
  return 0;
}

/** Tope de la lista: es una vista operativa, no un export. */
export const ADMIN_LOAN_LIST_LIMIT = 50;

export interface AdminLoanFilter {
  status?: LoanStatusValue;
}

export interface DisbursementReview {
  loan: AdminLoanItem;
  installments: LoanInstallmentDoc[];
  /** `null` mientras el desembolso no se ha iniciado. */
  disbursement: DisbursementDoc | null;
  /** Titular del préstamo: el admin debe ver a quién le va el dinero antes de transferir. */
  holder: UserDoc | null;
}

/**
 * Listado de préstamos para operar.
 *
 * Sin filtro usa el índice simple de `createdAt`. Con filtro de estado usa una query de
 * igualdad de un solo campo (índice automático, siempre disponible) y **ordena en memoria**:
 * un `orderBy` cruzado pediría el índice compuesto `[status, createdAt]`, que hoy no se puede
 * desplegar por falta de `roles/datastore.owner`. Desempate por `id` para orden estable.
 */
export async function listLoansForAdmin(
  deps: AdminLoanDeps,
  filter: AdminLoanFilter = {},
): Promise<AdminLoanItem[]> {
  const base = deps.db.collection("loans");
  const snap = filter.status
    ? await base.where("status", "==", filter.status).limit(ADMIN_LOAN_LIST_LIMIT).get()
    : await base.orderBy("createdAt", "desc").limit(ADMIN_LOAN_LIST_LIMIT).get();

  return snap.docs
    .map((doc) => ({ ...(doc.data() as LoanDoc), id: doc.id }))
    .sort((a, b) => {
      // `createdAt` es `CreditDocDate` (Date | Timestamp): se normaliza antes de comparar.
      const diff = toMillis(b.createdAt) - toMillis(a.createdAt);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
}

/**
 * Todo lo que hace falta para transferir un préstamo: el loan, su calendario, el estado del
 * desembolso y el titular. 404 si el préstamo no existe.
 *
 * Las cuotas se leen por id determinista con un `getAll` (mismo motivo que en el servicio de
 * desembolso): sin índice compuesto y sin query.
 */
export async function getLoanForDisbursement(
  deps: AdminLoanDeps,
  loanId: string,
): Promise<DisbursementReview> {
  const loanSnap = await deps.db.collection("loans").doc(loanId).get();
  if (!loanSnap.exists) {
    throw notFound("Préstamo no encontrado");
  }
  const loan: AdminLoanItem = { ...(loanSnap.data() as LoanDoc), id: loanSnap.id };

  const termInstallments = loan.pricing?.termInstallments ?? 0;
  const [installmentSnaps, disbursementSnap, holderSnap] = await Promise.all([
    termInstallments > 0
      ? deps.db.getAll(
          ...Array.from({ length: termInstallments }, (_, i) =>
            deps.db.collection("loan_installments").doc(loanInstallmentDocId(loanId, i + 1)),
          ),
        )
      : Promise.resolve([]),
    deps.db.collection("disbursements").doc(loanId).get(),
    loan.userId ? deps.db.collection("users").doc(loan.userId).get() : Promise.resolve(null),
  ]);

  return {
    loan,
    installments: installmentSnaps
      .filter((snap) => snap.exists)
      .map((snap) => snap.data() as LoanInstallmentDoc)
      .sort((a, b) => a.installmentNumber - b.installmentNumber),
    disbursement: disbursementSnap.exists ? (disbursementSnap.data() as DisbursementDoc) : null,
    holder: holderSnap && holderSnap.exists ? (holderSnap.data() as UserDoc) : null,
  };
}

/** Préstamos que esperan desembolso: la cola de trabajo de la fase. */
export async function listLoansAwaitingDisbursement(
  deps: AdminLoanDeps,
): Promise<AdminLoanItem[]> {
  return listLoansForAdmin(deps, { status: LoanStatus.PENDING_DISBURSEMENT });
}
