import type { Firestore } from "firebase-admin/firestore";
import { listLoansForUser, listInstallmentsForLoan } from "@/services/credit/loan-service";
import { buildClientDashboard, type DashboardInstallmentView, type DashboardLoanView, type DashboardNotificationView } from "@/server/client-dashboard";
import { toIso } from "@/lib/loan-json";
import { DelinquencyStatus } from "@/server/types";
import type { LoanDoc, LoanInstallmentDoc } from "@/server/credit-doc";

/**
 * Datos del dashboard del cliente (F12). SOLO lectura: la pantalla de inicio no puede ensuciar
 * `loans`, `loan_installments` ni `notifications` (misma regla que F11-1 con la cartera).
 *
 * Las consultas usan índices simples a propósito (sin `orderBy` compuesto, trampa de F9-2):
 * `loans` por `userId`, cuotas por `loanId` y avisos por `userId`, ordenados en memoria. Un
 * usuario tiene un puñado de filas, así que el orden en memoria es determinista.
 */

export interface ClientDashboardDeps {
  db: Firestore;
}

export async function loadClientDashboard(
  deps: ClientDashboardDeps,
  userId: string,
  today: Date = new Date(),
) {
  const loans = await listLoansForUser(deps.db, userId);
  const activeLoan = loans.find((loan) => loan.status === "PENDING_DISBURSEMENT" || loan.status === "DISBURSED" || loan.status === "DEFAULTED");

  const installments = activeLoan ? await listInstallmentsForLoan(deps.db, activeLoan.id) : [];
  const notifications = await loadNotificationsForUser(deps, userId);

  return buildClientDashboard({
    loans: loans.map(toLoanView),
    installments: installments.map(toInstallmentView),
    notifications,
    today,
  });
}

export async function loadNotificationsForUser(
  deps: ClientDashboardDeps,
  userId: string,
): Promise<DashboardNotificationView[]> {
  const snap = await deps.db.collection("notifications").where("userId", "==", userId).get();
  const rows = snap.docs.map((doc) => {
    const data = doc.data() as {
      type: DashboardNotificationView["type"];
      title: string;
      body: string;
      sentAt?: LoanDoc["createdAt"];
    };
    return {
      id: doc.id,
      type: data.type,
      title: data.title,
      body: data.body,
      sentAtIso: data.sentAt ? toIso(data.sentAt) : null,
    };
  });
  return rows.sort((a, b) => {
    const ta = a.sentAtIso ?? "";
    const tb = b.sentAtIso ?? "";
    return tb.localeCompare(ta) || a.id.localeCompare(b.id);
  });
}

function toLoanView(loan: LoanDoc & { id: string }): DashboardLoanView {
  return {
    id: loan.id,
    loanNumber: loan.loanNumber,
    status: loan.status,
    principalPesos: loan.principalPesos,
    totalPayablePesos: loan.totalPayablePesos,
    outstandingPesos: loan.outstandingPesos ?? 0,
    delinquencyStatus: loan.delinquencyStatus ?? DelinquencyStatus.CURRENT,
    daysPastDue: loan.daysPastDue ?? 0,
    createdAtIso: toIso(loan.createdAt),
  };
}

function toInstallmentView(cuota: LoanInstallmentDoc & { id: string }): DashboardInstallmentView {
  return {
    installmentNumber: cuota.installmentNumber,
    dueDateIso: toIso(cuota.dueDate),
    totalPesos: cuota.totalPesos,
    status: cuota.status,
  };
}