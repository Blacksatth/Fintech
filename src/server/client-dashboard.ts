import { DelinquencyStatus, InstallmentStatus, LoanStatus } from "@/server/types";
import { isActiveLoanStatus } from "@/server/credit-doc";
import { wholeDaysBetween } from "@/server/delinquency";
import type { NotificationType } from "@/server/notification-doc";

/**
 * Resumen del dashboard del cliente (PROJECT_SPEC FASE 12). Dominio puro: sin Firebase ni Next,
 * para que la elección del préstamo "activo", la próxima cuota y los estados vacíos se prueben
 * con fechas y préstamos inventados.
 *
 * Principios:
 * - **Solo lectura.** Este módulo no escribe: la pantalla de inicio no puede ensuciar `loans`
 *   (misma regla que F11-1 con la cartera de mora).
 * - **La próxima cuota se deriva de los datos, no se persiste.** Igual que `summarizeLoan`:
 *   la última palabra es la primera cuota `PENDING` por vencimiento.
 * - **El préstamo activo es el del invariante de F8** (`ACTIVE_LOAN_STATUSES`: solo puede haber
 *   uno). Si no hay ninguno, se ofrece el estado vacío con el último préstamo como contexto.
 * - **Los días se calculan en UTC** con `wholeDaysBetween` (trampa conocida del proyecto: un
 *   vencimiento es medianoche UTC y formatearlo en zona del navegador lo corre un día).
 */

export interface DashboardLoanView {
  id: string;
  loanNumber: string;
  status: LoanStatus;
  principalPesos: number;
  totalPayablePesos: number;
  outstandingPesos: number;
  delinquencyStatus: DelinquencyStatus;
  daysPastDue: number;
  createdAtIso: string;
}

export interface DashboardInstallmentView {
  installmentNumber: number;
  dueDateIso: string;
  totalPesos: number;
  status: InstallmentStatus;
}

export interface DashboardNotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  /** `null` si el aviso no llegara a tener `sentAt` (no debería pasar con docs SENT). */
  sentAtIso: string | null;
}

export interface NextInstallmentView {
  installmentNumber: number;
  totalPesos: number;
  dueDateIso: string;
  /**
   * Días enteros (UTC) desde hoy hasta el vencimiento, con signo:
   * positivo = aún no vence; `0` = vence hoy; negativo = lleva vencida esa cantidad de días.
   */
  daysUntil: number;
}

export type ClientDashboardMode = "no_loans" | "no_active" | "active";

/**
 * Unión discriminada por `mode`: los campos que existen dependen del estado del cliente.
 * En `"active"` el préstamo activo SIEMPRE existe (invariante de F8: solo puede haber uno y, si
 * lo hay, esta rama se cumple); en los otros dos queda `null` a propósito. Así el componente no
 * puede leer `activeLoan` pensando que es opcional. Los avisos viven en las tres ramas.
 */
export type ClientDashboardSnapshot =
  | {
      mode: "no_loans";
      activeLoan: null;
      lastLoan: null;
      installments: never[];
      next: null;
      paidInstallments: 0;
      installmentCount: 0;
      canRegisterPayment: false;
      notifications: DashboardNotificationView[];
    }
  | {
      mode: "no_active";
      activeLoan: null;
      lastLoan: DashboardLoanView;
      installments: never[];
      next: null;
      paidInstallments: 0;
      installmentCount: 0;
      canRegisterPayment: false;
      notifications: DashboardNotificationView[];
    }
  | {
      mode: "active";
      activeLoan: DashboardLoanView;
      lastLoan: null;
      installments: DashboardInstallmentView[];
      next: NextInstallmentView | null;
      paidInstallments: number;
      installmentCount: number;
      canRegisterPayment: boolean;
      notifications: DashboardNotificationView[];
    };

/** Estados sobre los que se puede registrar un pago: los de `assertLoanAcceptsPayments`. */
const REGISTRABLE_LOAN_STATUSES: readonly LoanStatus[] = [LoanStatus.DISBURSED, LoanStatus.DEFAULTED];

export interface ClientDashboardInput {
  loans: readonly DashboardLoanView[];
  /** Cuotas del préstamo activo (si no hay activo, se ignora el contenido). */
  installments: readonly DashboardInstallmentView[];
  notifications: readonly DashboardNotificationView[];
  today: Date;
}

export function buildClientDashboard(input: ClientDashboardInput): ClientDashboardSnapshot {
  const activeLoan = input.loans.find((loan) => isActiveLoanStatus(loan.status)) ?? null;

  if (!activeLoan) {
    const lastLoan = [...input.loans].sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso))[0];
    const notifications = sortNotificationsDesc(input.notifications).slice(0, 5);

    if (!lastLoan) {
      return {
        mode: "no_loans",
        activeLoan: null,
        lastLoan: null,
        installments: [],
        next: null,
        paidInstallments: 0,
        installmentCount: 0,
        canRegisterPayment: false,
        notifications,
      };
    }

    return {
      mode: "no_active",
      activeLoan: null,
      lastLoan,
      installments: [],
      next: null,
      paidInstallments: 0,
      installmentCount: 0,
      canRegisterPayment: false,
      notifications,
    };
  }

  const installments = [...input.installments].sort(
    (a, b) => a.installmentNumber - b.installmentNumber,
  );
  const next = installments
    .filter((cuota) => cuota.status === InstallmentStatus.PENDING)
    .sort((a, b) => a.dueDateIso.localeCompare(b.dueDateIso))[0];

  const paidInstallments = installments.filter(
    (cuota) => cuota.status === InstallmentStatus.PAID,
  ).length;

  const canRegisterPayment =
    REGISTRABLE_LOAN_STATUSES.includes(activeLoan.status) &&
    next !== undefined &&
    activeLoan.outstandingPesos > 0;

  return {
    mode: "active",
    activeLoan,
    lastLoan: null,
    installments,
    next: next
      ? {
          installmentNumber: next.installmentNumber,
          totalPesos: next.totalPesos,
          dueDateIso: next.dueDateIso,
          daysUntil: wholeDaysBetween(input.today, new Date(next.dueDateIso)),
        }
      : null,
    paidInstallments,
    installmentCount: installments.length,
    canRegisterPayment,
    notifications: sortNotificationsDesc(input.notifications).slice(0, 5),
  };
}

function sortNotificationsDesc(
  notifications: readonly DashboardNotificationView[],
): DashboardNotificationView[] {
  return [...notifications].sort((a, b) => {
    const ta = a.sentAtIso ?? "";
    const tb = b.sentAtIso ?? "";
    return tb.localeCompare(ta) || a.id.localeCompare(b.id);
  });
}