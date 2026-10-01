import { describe, expect, it } from "vitest";
import { buildClientDashboard, type DashboardInstallmentView, type DashboardLoanView } from "./client-dashboard";
import { DelinquencyStatus, InstallmentStatus, LoanStatus } from "./types";

const HOY = new Date("2026-09-29T00:00:00Z");

function loan(overrides: Partial<DashboardLoanView> = {}): DashboardLoanView {
  return {
    id: "loan-1",
    loanNumber: "LOAN-0001",
    status: LoanStatus.DISBURSED,
    principalPesos: 500_000,
    totalPayablePesos: 648_060,
    outstandingPesos: 388_836,
    delinquencyStatus: DelinquencyStatus.CURRENT,
    daysPastDue: 0,
    createdAtIso: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function cuota(overrides: Partial<DashboardInstallmentView> = {}): DashboardInstallmentView {
  return {
    installmentNumber: 1,
    dueDateIso: "2026-09-10T00:00:00.000Z",
    totalPesos: 64_806,
    status: InstallmentStatus.PENDING,
    ...overrides,
  };
}

function aviso(sentAtIso: string | null, overrides: Partial<{ id: string; title: string }> = {}) {
  return {
    id: overrides.id ?? `aviso-${sentAtIso ?? "sin"}`,
    type: "INSTALLMENT_OVERDUE" as const,
    title: overrides.title ?? "Cuota vencida",
    body: "Tu cuota 2 lleva 3 días de atraso.",
    sentAtIso,
  };
}

describe("buildClientDashboard", () => {
  it("sin préstamos ni avisos: modo no_loans, sin préstamo activo ni último", () => {
    const snapshot = buildClientDashboard({ loans: [], installments: [], notifications: [], today: HOY });
    expect(snapshot.mode).toBe("no_loans");
    expect(snapshot.activeLoan).toBeNull();
    expect(snapshot.lastLoan).toBeNull();
    expect(snapshot.next).toBeNull();
    expect(snapshot.canRegisterPayment).toBe(false);
    expect(snapshot.notifications).toEqual([]);
  });

  it("con solo préstamos cerrados: modo no_active y el último es el más reciente", () => {
    const viejos = loan({ id: "loan-viejo", loanNumber: "LOAN-0001", status: LoanStatus.PAID, createdAtIso: "2026-01-05T00:00:00.000Z" });
    const recientes = loan({ id: "loan-reciente", loanNumber: "LOAN-0002", status: LoanStatus.PAID, createdAtIso: "2026-06-05T00:00:00.000Z" });
    const snapshot = buildClientDashboard({ loans: [viejos, recientes], installments: [], notifications: [], today: HOY });
    expect(snapshot.mode).toBe("no_active");
    expect(snapshot.lastLoan?.id).toBe("loan-reciente");
    expect(snapshot.activeLoan).toBeNull();
    expect(snapshot.canRegisterPayment).toBe(false);
  });

  it("préstamo activo desembolsado: próxima cuota pendiente, saldo y progreso", () => {
    const activo = loan({ outstandingPesos: 388_836 });
    const c1 = cuota({ installmentNumber: 1, dueDateIso: "2026-09-10T00:00:00.000Z", status: InstallmentStatus.PAID, totalPesos: 64_806 });
    const c2 = cuota({ installmentNumber: 2, dueDateIso: "2026-09-30T00:00:00.000Z", totalPesos: 64_806 });
    const c3 = cuota({ installmentNumber: 3, dueDateIso: "2026-10-30T00:00:00.000Z", totalPesos: 64_806 });

    const snapshot = buildClientDashboard({ loans: [activo], installments: [c3, c2, c1], notifications: [], today: HOY });

    expect(snapshot.mode).toBe("active");
    expect(snapshot.activeLoan?.id).toBe("loan-1");
    expect(snapshot.installmentCount).toBe(3);
    expect(snapshot.paidInstallments).toBe(1);
    expect(snapshot.next?.installmentNumber).toBe(2);
    expect(snapshot.next?.totalPesos).toBe(64_806);
    // 30/09 - 29/09 = 1 día (la cuota 1 vencida no cuenta: ya está pagada).
    expect(snapshot.next?.daysUntil).toBe(1);
    expect(snapshot.canRegisterPayment).toBe(true);
  });

  it("vence hoy: daysUntil = 0; vencida ayer: daysUntil negativo (sin correr un día por zona horaria)", () => {
    const hoy = cuota({ dueDateIso: "2026-09-29T00:00:00.000Z" });
    const ayer = cuota({ dueDateIso: "2026-09-28T00:00:00.000Z", installmentNumber: 2 });

    expect(
      buildClientDashboard({ loans: [loan()], installments: [hoy], notifications: [], today: HOY }).next?.daysUntil,
    ).toBe(0);
    expect(
      buildClientDashboard({ loans: [loan()], installments: [ayer], notifications: [], today: HOY }).next?.daysUntil,
    ).toBe(-1);
  });

  it("la primera pendiente se elige por vencimiento, no por número de cuota", () => {
    const c5 = cuota({ installmentNumber: 5, dueDateIso: "2026-11-10T00:00:00.000Z" });
    const c3 = cuota({ installmentNumber: 3, dueDateIso: "2026-10-10T00:00:00.000Z" });
    const snapshot = buildClientDashboard({ loans: [loan()], installments: [c5, c3], notifications: [], today: HOY });
    expect(snapshot.next?.installmentNumber).toBe(3);
    expect(snapshot.next?.daysUntil).toBe(11);
  });

  it("pendiente de desembolso: activo pero no se puede registrar pago", () => {
    const pendiente = loan({ status: LoanStatus.PENDING_DISBURSEMENT });
    const snapshot = buildClientDashboard({
      loans: [pendiente],
      installments: [cuota({ dueDateIso: "2026-10-10T00:00:00.000Z" })],
      notifications: [],
      today: HOY,
    });
    expect(snapshot.mode).toBe("active");
    expect(snapshot.next).not.toBeNull();
    expect(snapshot.canRegisterPayment).toBe(false);
  });

  it("en mora (DEFAULTED): sigue siendo activo y se le puede registrar un pago", () => {
    const enMora = loan({
      status: LoanStatus.DEFAULTED,
      delinquencyStatus: DelinquencyStatus.DEFAULT,
      daysPastDue: 40,
      outstandingPesos: 259_224,
    });
    const snapshot = buildClientDashboard({ loans: [enMora], installments: [cuota()], notifications: [], today: HOY });
    expect(snapshot.mode).toBe("active");
    expect(snapshot.activeLoan?.daysPastDue).toBe(40);
    expect(snapshot.canRegisterPayment).toBe(true);
  });

  it("sin cuotas pendientes: no hay próxima cuota ni pago registrable", () => {
    const saldado = loan({
      status: LoanStatus.DISBURSED,
      outstandingPesos: 0,
      delinquencyStatus: DelinquencyStatus.PAID,
    });
    const c1 = cuota({ status: InstallmentStatus.PAID });
    const snapshot = buildClientDashboard({ loans: [saldado], installments: [c1], notifications: [], today: HOY });
    expect(snapshot.next).toBeNull();
    expect(snapshot.canRegisterPayment).toBe(false);
    expect(snapshot.paidInstallments).toBe(1);
  });

  it("saldo pendiente pero sin calendario (dato roto): no ofrece pago", () => {
    const snapshot = buildClientDashboard({ loans: [loan({ outstandingPesos: 100_000 })], installments: [], notifications: [], today: HOY });
    expect(snapshot.mode).toBe("active");
    expect(snapshot.next).toBeNull();
    expect(snapshot.canRegisterPayment).toBe(false);
  });

  it("avisos: ordenados del más reciente al más viejo y recortados a 5", () => {
    const six = Array.from({ length: 6 }, (_, i) => aviso(`2026-09-${String(25 + i).padStart(2, "0")}T10:00:00.000Z`, { id: `aviso-${i}` }));
    // `i=0` -> 25/09 ... `i=5` -> 30/09, el más reciente.
    const snapshot = buildClientDashboard({ loans: [], installments: [], notifications: six, today: HOY });
    expect(snapshot.notifications).toHaveLength(5);
    expect(snapshot.notifications[0].id).toBe("aviso-5");
    expect(snapshot.notifications[4].id).toBe("aviso-1");
  });

  it("aviso sin sentAt va al final del orden y no rompe", () => {
    const conFecha = aviso("2026-09-28T10:00:00.000Z", { id: "con-fecha" });
    const sinFecha = aviso(null, { id: "sin-fecha" });
    const snapshot = buildClientDashboard({ loans: [], installments: [], notifications: [sinFecha, conFecha], today: HOY });
    expect(snapshot.notifications[0].id).toBe("con-fecha");
    expect(snapshot.notifications[1].id).toBe("sin-fecha");
    expect(snapshot.notifications[1].sentAtIso).toBeNull();
  });
});