import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  getLoanForDisbursement,
  listLoansForAdmin,
  listLoansAwaitingDisbursement,
} from "./admin-loan-service";
import { createFirestoreMock } from "@/test-utils/firestore-mock";
import { LoanStatus, TermFrequency } from "@/server/types";

const T0 = new Date("2026-09-01T12:00:00.000Z");
const T1 = new Date("2026-09-05T12:00:00.000Z");
const T2 = new Date("2026-09-09T12:00:00.000Z");

function loanDoc(id: string, status: LoanStatus, createdAt: Date) {
  return {
    loanNumber: `LOAN-${id}`,
    applicationId: "APP-1",
    userId: `uid-${id}`,
    productCode: "MICRO_BASICO",
    principalPesos: 50_000,
    interestPesos: 1_156,
    feePesos: 2_500,
    totalPayablePesos: 53_656,
    pricing: {
      annualRateBps: 2_400,
      effectiveFeeBps: 500,
      rateVersion: 1,
      termInstallments: 2,
      termFrequency: TermFrequency.BIWEEKLY,
    },
    status,
    createdAt,
    updatedAt: createdAt,
  };
}

function installmentDoc(loanId: string, n: number, dueDate: Date) {
  return {
    loanId,
    installmentNumber: n,
    dueDate,
    principalPesos: 25_000,
    interestPesos: 578,
    feePesos: 1_250,
    totalPesos: 26_828,
    paidPesos: 0,
    status: "PENDING",
  };
}

function setup() {
  const { store, db } = createFirestoreMock();
  store.seed("loans", "loan-a", loanDoc("a", LoanStatus.PENDING_DISBURSEMENT, T1));
  store.seed("loans", "loan-b", loanDoc("b", LoanStatus.DISBURSED, T2));
  store.seed("loans", "loan-c", loanDoc("c", LoanStatus.PENDING_DISBURSEMENT, T0));
  for (const loanId of ["loan-a", "loan-c"]) {
    store.seed("loan_installments", `${loanId}_1`, installmentDoc(loanId, 1, T1));
    store.seed("loan_installments", `${loanId}_2`, installmentDoc(loanId, 2, T2));
  }
  store.seed("users", "uid-a", { email: "a@local.dev", fullName: "Ana Pérez", role: "CUSTOMER" });
  return { db: db as Firestore, store };
}

describe("listLoansForAdmin", () => {
  it("filtra por estado y ordena de mas reciente a mas antiguo", async () => {
    const { db } = setup();

    const resultado = await listLoansForAdmin({ db }, { status: LoanStatus.PENDING_DISBURSEMENT });

    expect(resultado.map((l) => l.id)).toEqual(["loan-a", "loan-c"]);
  });

  it("sin filtro trae todos ordenados por fecha de creación", async () => {
    const { db } = setup();

    const resultado = await listLoansForAdmin({ db });

    expect(resultado.map((l) => l.id)).toEqual(["loan-b", "loan-a", "loan-c"]);
  });

  it("la cola de trabajo son los pendientes de desembolso", async () => {
    const { db } = setup();

    const resultado = await listLoansAwaitingDisbursement({ db });

    expect(resultado).toHaveLength(2);
    expect(resultado.every((l) => l.status === LoanStatus.PENDING_DISBURSEMENT)).toBe(true);
  });

  it("desempata por id para que el orden sea estable", async () => {
    const { store, db } = setup();
    store.seed("loans", "loan-d", loanDoc("d", LoanStatus.PENDING_DISBURSEMENT, T1));

    const resultado = await listLoansForAdmin({ db }, { status: LoanStatus.PENDING_DISBURSEMENT });

    expect(resultado.map((l) => l.id)).toEqual(["loan-a", "loan-d", "loan-c"]);
  });
});

describe("getLoanForDisbursement", () => {
  it("trae loan, cuotas, disbursement y titular", async () => {
    const { db } = setup();
    await db.collection("disbursements").doc("loan-a").set({
      loanId: "loan-a",
      provider: "manual",
      status: "INITIATED",
      reference: "REF-1",
      initiatedBy: "admin-1",
      initiatedAt: T1,
      idempotencyKey: "k1",
    });

    const review = await getLoanForDisbursement({ db }, "loan-a");

    expect(review.loan.loanNumber).toBe("LOAN-a");
    expect(review.installments.map((c) => c.installmentNumber)).toEqual([1, 2]);
    expect(review.disbursement?.status).toBe("INITIATED");
    expect(review.holder?.fullName).toBe("Ana Pérez");
  });

  it("sin desembolso devuelve null, no lanza", async () => {
    const { db } = setup();

    const review = await getLoanForDisbursement({ db }, "loan-a");

    expect(review.disbursement).toBeNull();
  });

  it("404 si el préstamo no existe", async () => {
    const { db } = setup();

    await expect(getLoanForDisbursement({ db }, "no-existe")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("un préstamo sin snapshot no rompe la vista: trae las cuotas sin leer por getAll", async () => {
    const { store, db } = setup();
    store.seed("loans", "loan-legacy", {
      loanNumber: "LOAN-LEGACY",
      userId: "uid-legacy",
      principalPesos: 10_000,
      status: LoanStatus.PENDING_DISBURSEMENT,
      createdAt: T0,
      updatedAt: T0,
    });

    const review = await getLoanForDisbursement({ db }, "loan-legacy");

    expect(review.loan.id).toBe("loan-legacy");
    expect(review.installments).toEqual([]);
  });
});
