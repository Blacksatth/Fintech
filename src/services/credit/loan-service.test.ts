import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  findNextInstallment,
  getLoanForUser,
  listInstallmentsForLoan,
  listLoansForUser,
  summarizeLoan,
} from "./loan-service";
import { createFirestoreMock } from "@/test-utils/firestore-mock";
import { DelinquencyStatus, InstallmentStatus, LoanStatus } from "@/server/types";

const T0 = new Date("2026-09-01T12:00:00.000Z");
const T1 = new Date("2026-10-01T12:00:00.000Z");
const T2 = new Date("2026-11-01T12:00:00.000Z");

function loanDoc(overrides: Record<string, unknown> = {}) {
  return {
    loanNumber: "LOAN-0001",
    applicationId: "APP-1",
    userId: "uid-1",
    productCode: "MICRO_BASICO",
    principalPesos: 50_000,
    interestPesos: 1_505,
    feePesos: 2_500,
    totalPayablePesos: 54_005,
    status: LoanStatus.PENDING_DISBURSEMENT,
    delinquencyStatus: DelinquencyStatus.CURRENT,
    daysPastDue: 0,
    outstandingPesos: 54_005,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function installmentDoc(n: number, overrides: Record<string, unknown> = {}) {
  return {
    loanId: "loan-1",
    installmentNumber: n,
    dueDate: new Date(2026, 8, n),
    principalPesos: 20_000,
    interestPesos: 600,
    feePesos: 1_000,
    totalPesos: 21_600,
    paidPesos: 0,
    status: InstallmentStatus.PENDING,
    ...overrides,
  };
}

function setup(): { db: Firestore; store: ReturnType<typeof createFirestoreMock>["store"] } {
  const { store, db } = createFirestoreMock();
  return { db, store };
}

describe("lectura de prestamos del cliente (F8-3)", () => {
  it("lista solo los prestamos del usuario, del mas nuevo al mas viejo", async () => {
    const { db, store } = setup();
    store.seed("loans", "loan-old", loanDoc({ loanNumber: "LOAN-OLD", createdAt: T0 }));
    store.seed("loans", "loan-new", loanDoc({ loanNumber: "LOAN-NEW", createdAt: T2 }));
    store.seed("loans", "loan-mid", loanDoc({ loanNumber: "LOAN-MID", createdAt: T1 }));
    store.seed("loans", "loan-otro", loanDoc({ loanNumber: "LOAN-OTRO", userId: "uid-2", createdAt: T2 }));

    const loans = await listLoansForUser(db, "uid-1");

    expect(loans.map((l) => l.loanNumber)).toEqual(["LOAN-NEW", "LOAN-MID", "LOAN-OLD"]);
  });

  it("devuelve lista vacia si el usuario no tiene prestamos", async () => {
    const { db } = setup();
    await expect(listLoansForUser(db, "uid-1")).resolves.toEqual([]);
  });

  it("getLoanForUser devuelve el prestamo del propio usuario", async () => {
    const { db, store } = setup();
    store.seed("loans", "loan-1", loanDoc());

    const loan = await getLoanForUser(db, "uid-1", "loan-1");

    expect(loan.id).toBe("loan-1");
    expect(loan.loanNumber).toBe("LOAN-0001");
  });

  it("getLoanForUser da 404 si el prestamo no existe", async () => {
    const { db } = setup();
    await expect(getLoanForUser(db, "uid-1", "no-existe")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("getLoanForUser da 404 si el prestamo es de otro usuario (no revela que exista)", async () => {
    const { db, store } = setup();
    store.seed("loans", "loan-1", loanDoc({ userId: "uid-2" }));

    await expect(getLoanForUser(db, "uid-1", "loan-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("el 404 es identico si el prestamo es ajeno o si no existe", async () => {
    const { db, store } = setup();
    store.seed("loans", "loan-1", loanDoc({ userId: "uid-2" }));

    const ajeno = await getLoanForUser(db, "uid-1", "loan-1").catch((e: unknown) => e);
    const inexistente = await getLoanForUser(db, "uid-1", "no-existe").catch((e: unknown) => e);

    expect(ajeno).toBeInstanceOf(Error);
    expect((ajeno as Error).message).toBe((inexistente as Error).message);
    expect((ajeno as { statusCode?: number }).statusCode).toBe(
      (inexistente as { statusCode?: number }).statusCode,
    );
  });

  it("lista las cuotas ordenadas por numero", async () => {
    const { db, store } = setup();
    store.seed("loan_installments", "loan-1_3", installmentDoc(3));
    store.seed("loan_installments", "loan-1_1", installmentDoc(1));
    store.seed("loan_installments", "loan-1_2", installmentDoc(2));
    store.seed("loan_installments", "otro_1", installmentDoc(1, { loanId: "otro" }));

    const cuotas = await listInstallmentsForLoan(db, "loan-1");

    expect(cuotas.map((c) => c.installmentNumber)).toEqual([1, 2, 3]);
  });

  it("findNextInstallment devuelve la primera cuota PENDING por vencimiento", () => {
    const primera = { ...installmentDoc(1), status: InstallmentStatus.PAID, installmentNumber: 1 };
    const segunda = { ...installmentDoc(2), status: InstallmentStatus.PENDING, installmentNumber: 2 };
    const tercera = { ...installmentDoc(3), status: InstallmentStatus.PENDING, installmentNumber: 3 };

    const siguiente = findNextInstallment([
      { ...primera, id: "a" } as never,
      { ...tercera, id: "c" } as never,
      { ...segunda, id: "b" } as never,
    ]);

    expect(siguiente?.installmentNumber).toBe(2);
  });

  it("findNextInstallment ignora cuotas pagadas aunque su vencimiento sea el mas proximo", () => {
    const cuotas = [
      { ...installmentDoc(1), id: "a", status: InstallmentStatus.PAID, dueDate: new Date(2026, 0, 5) },
      { ...installmentDoc(2), id: "b", status: InstallmentStatus.PENDING, dueDate: new Date(2026, 0, 20) },
    ] as never[];

    expect(findNextInstallment(cuotas)?.installmentNumber).toBe(2);
  });

  it("findNextInstallment es undefined si no queda ninguna cuota pendiente", () => {
    const cuotas = [{ ...installmentDoc(1), id: "a", status: InstallmentStatus.PAID }] as never[];
    expect(findNextInstallment(cuotas)).toBeUndefined();
  });

  it("summarizeLoan expone saldo, total y proximo vencimiento para la UI", async () => {
    const { db, store } = setup();
    store.seed("loans", "loan-1", loanDoc());
    store.seed("loan_installments", "loan-1_1", installmentDoc(1));
    store.seed("loan_installments", "loan-1_2", installmentDoc(2, { installmentNumber: 2 }));

    const resumen = await summarizeLoan(db, "uid-1", "loan-1");

    expect(resumen.loan.id).toBe("loan-1");
    expect(resumen.installments).toHaveLength(2);
    expect(resumen.nextDueAt).toBeInstanceOf(Date);
    expect(resumen.nextDueAt?.getTime()).toBe(new Date(2026, 8, 1).getTime());
    expect(resumen.outstandingPesos).toBe(54_005);
    expect(resumen.paidInstallments).toBe(0);
    expect(resumen.installmentCount).toBe(2);
  });

  it("summarizeLoan cuenta las cuotas pagadas", async () => {
    const { db, store } = setup();
    store.seed("loans", "loan-1", loanDoc({ outstandingPesos: 32_400 }));
    store.seed(
      "loan_installments",
      "loan-1_1",
      installmentDoc(1, { status: InstallmentStatus.PAID, paidPesos: 21_600, paidAt: T0 }),
    );
    store.seed("loan_installments", "loan-1_2", installmentDoc(2));

    const resumen = await summarizeLoan(db, "uid-1", "loan-1");

    expect(resumen.paidInstallments).toBe(1);
    expect(resumen.outstandingPesos).toBe(32_400);
  });

  it("summarizeLoan no expone proximo vencimiento cuando ya no hay cuotas pendientes", async () => {
    const { db, store } = setup();
    store.seed("loans", "loan-1", loanDoc({ status: LoanStatus.PAID, outstandingPesos: 0 }));
    store.seed("loan_installments", "loan-1_1", installmentDoc(1, { status: InstallmentStatus.PAID }));

    const resumen = await summarizeLoan(db, "uid-1", "loan-1");

    expect(resumen.nextDueAt).toBeUndefined();
  });
});
