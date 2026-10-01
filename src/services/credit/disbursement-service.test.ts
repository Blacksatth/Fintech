import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  confirmLoanDisbursement,
  initiateLoanDisbursement,
  type DisbursementActor,
} from "./disbursement-service";
import { createFirestoreMock } from "@/test-utils/firestore-mock";
import { addPeriods } from "@/server/schedule";
import {
  AuditAction,
  DelinquencyStatus,
  InstallmentStatus,
  LoanStatus,
  Role,
  TermFrequency,
} from "@/server/types";

const ADMIN: DisbursementActor = { uid: "admin-1", role: Role.ADMIN };
const CUSTOMER: DisbursementActor = { uid: "uid-1", role: Role.CUSTOMER };
const APROBADO = new Date("2026-03-24T00:00:00.000Z");

interface Cuota {
  installmentNumber: number;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  totalPesos: number;
  status?: InstallmentStatus;
}

/** Importes reales de `buildLoanSchedule(50000, 2400bps, 500bps, 4, BIWEEKLY)`. */
const CUOTAS: readonly Cuota[] = [
  { installmentNumber: 1, principalPesos: 12_329, interestPesos: 460, feePesos: 625, totalPesos: 13_414 },
  { installmentNumber: 2, principalPesos: 12_442, interestPesos: 347, feePesos: 625, totalPesos: 13_414 },
  { installmentNumber: 3, principalPesos: 12_557, interestPesos: 232, feePesos: 625, totalPesos: 13_414 },
  { installmentNumber: 4, principalPesos: 12_672, interestPesos: 117, feePesos: 625, totalPesos: 13_414 },
] as const;

function setup(overrides: { sinPricing?: boolean; installments?: readonly Cuota[] } = {}) {
  const { store, db } = createFirestoreMock();

  const loanDoc: Record<string, unknown> = {
    loanNumber: "LOAN-0001",
    applicationId: "APP-1",
    userId: "uid-1",
    productCode: "MICRO_BASICO",
    principalPesos: 50_000,
    interestPesos: 1_156,
    feePesos: 2_500,
    totalPayablePesos: 53_656,
    status: LoanStatus.PENDING_DISBURSEMENT,
    delinquencyStatus: DelinquencyStatus.CURRENT,
    daysPastDue: 0,
    outstandingPesos: 53_656,
    createdAt: APROBADO,
    updatedAt: APROBADO,
  };
  // `sinPricing` omite el campo por completo, como los préstamos reales creados antes del
  // snapshot. Un `undefined` explícito no sirve: el seed no puede distinguirlo del default.
  if (overrides.sinPricing !== true) {
    loanDoc["pricing"] = {
      annualRateBps: 2_400,
      effectiveFeeBps: 500,
      rateVersion: 1,
      termInstallments: 4,
      termFrequency: TermFrequency.BIWEEKLY,
    };
  }
  store.seed("loans", "loan-1", loanDoc);

  const cuotas = overrides.installments ?? CUOTAS;
  for (const cuota of cuotas) {
    store.seed("loan_installments", `loan-1_${cuota.installmentNumber}`, {
      loanId: "loan-1",
      // Vencimientos provisionales: los que se programaron al aprobar.
      dueDate: addPeriods(APROBADO, TermFrequency.BIWEEKLY, cuota.installmentNumber),
      paidPesos: 0,
      status: InstallmentStatus.PENDING,
      ...cuota,
    });
  }

  return { db: db as Firestore, store };
}

function audits(store: ReturnType<typeof createFirestoreMock>["store"], action: string) {
  return store.list("audit_logs").filter((row) => row["action"] === action);
}

function installment(store: ReturnType<typeof createFirestoreMock>["store"], n: number) {
  return store.read("loan_installments", `loan-1_${n}`)!;
}

function loan(store: ReturnType<typeof createFirestoreMock>["store"]) {
  return store.read("loans", "loan-1")!;
}

describe("initiateLoanDisbursement", () => {
  it("crea disbursements/{loanId} en INITIATED sin mover el préstamo", async () => {
    const { db, store } = setup();

    const result = await initiateLoanDisbursement(
      { db },
      { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k1", reference: "REF-1" },
    );

    const doc = store.read("disbursements", "loan-1")!;
    expect(doc["status"]).toBe("INITIATED");
    expect(doc["provider"]).toBe("manual");
    expect(doc["reference"]).toBe("REF-1");
    expect(doc["initiatedBy"]).toBe("admin-1");
    expect(doc["idempotencyKey"]).toBe("k1");
    expect(doc["confirmedAt"]).toBeUndefined();
    expect(result.status).toBe("INITIATED");
    expect(result.loanStatus).toBe(LoanStatus.PENDING_DISBURSEMENT);
    expect(result.replayed).toBe(false);
    expect(loan(store)["status"]).toBe(LoanStatus.PENDING_DISBURSEMENT);
  });

  it("audita el inicio con LOAN_DISBURSEMENT_INITIATED", async () => {
    const { db, store } = setup();

    await initiateLoanDisbursement(
      { db },
      { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k1", reference: "REF-1" },
    );

    const registros = audits(store, AuditAction.LOAN_DISBURSEMENT_INITIATED);
    expect(registros).toHaveLength(1);
    expect(registros[0]!["metadata"]).toMatchObject({ reference: "REF-1", provider: "manual" });
    expect(registros[0]!["actorId"]).toBe("admin-1");
  });

  it("no crea un segundo desembolso con otra clave", async () => {
    const { db } = setup();
    await initiateLoanDisbursement({ db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k1" });

    await expect(
      initiateLoanDisbursement({ db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("replay con la misma clave no duplica el doc ni la auditoria", async () => {
    const { db, store } = setup();
    const input = { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k1", reference: "REF-1" };

    const primero = await initiateLoanDisbursement({ db }, input);
    const segundo = await initiateLoanDisbursement({ db }, input);

    expect(primero.replayed).toBe(false);
    expect(segundo.replayed).toBe(true);
    expect(store.ids("disbursements")).toEqual(["loan-1"]);
    expect(audits(store, AuditAction.LOAN_DISBURSEMENT_INITIATED)).toHaveLength(1);
  });

  it("solo un administrador puede iniciar", async () => {
    const { db } = setup();

    await expect(
      initiateLoanDisbursement({ db }, { loanId: "loan-1", actor: CUSTOMER, idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("exige Idempotency-Key", async () => {
    const { db } = setup();

    await expect(
      initiateLoanDisbursement({ db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "  " }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("404 si el préstamo no existe", async () => {
    const { db } = setup();

    await expect(
      initiateLoanDisbursement({ db }, { loanId: "nope", actor: ADMIN, idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("no desembolsa un préstamo ya pagado o cancelado", async () => {
    const { db, store } = setup();
    store.seed("loans", "loan-1", { status: LoanStatus.PAID, loanNumber: "LOAN-0001" });

    await expect(
      initiateLoanDisbursement({ db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("confirmLoanDisbursement", () => {
  async function iniciado(overrides: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(overrides);
    await initiateLoanDisbursement(
      { db: ctx.db },
      { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k1", reference: "REF-1" },
    );
    return ctx;
  }

  it("pasa el préstamo a DISBURSED y reprograma los vencimientos desde la fecha real", async () => {
    const { db, store } = await iniciado();

    const result = await confirmLoanDisbursement(
      { db },
      { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2" },
    );

    const doc = loan(store);
    expect(doc["status"]).toBe(LoanStatus.DISBURSED);
    expect(doc["delinquencyStatus"]).toBe(DelinquencyStatus.CURRENT);
    const disbursedAt = doc["disbursedAt"] as Date;
    expect(disbursedAt).toBeInstanceOf(Date);

    for (let n = 1; n <= 4; n += 1) {
      expect(installment(store, n)["dueDate"]).toEqual(
        addPeriods(disbursedAt, TermFrequency.BIWEEKLY, n),
      );
    }
    expect(result.status).toBe("CONFIRMED");
    expect(result.reference).toBe("REF-1");
    expect(result.confirmedBy).toBe("admin-1");
    expect(result.loanStatus).toBe(LoanStatus.DISBURSED);
    expect(result.rescheduledInstallments).toBe(4);
  });

  it("no cambia ni un peso de los importes al re-programar", async () => {
    const { db, store } = await iniciado();
    const antes = [1, 2, 3, 4].map((n) => ({ ...installment(store, n) }));

    await confirmLoanDisbursement({ db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2" });

    for (const cuota of antes) {
      const ahora = installment(store, cuota["installmentNumber"] as number);
      expect(ahora["principalPesos"]).toBe(cuota["principalPesos"]);
      expect(ahora["interestPesos"]).toBe(cuota["interestPesos"]);
      expect(ahora["feePesos"]).toBe(cuota["feePesos"]);
      expect(ahora["totalPesos"]).toBe(cuota["totalPesos"]);
      expect(ahora["paidPesos"]).toBe(cuota["paidPesos"]);
      expect(ahora["status"]).toBe(cuota["status"]);
      expect(ahora["dueDate"]).not.toEqual(cuota["dueDate"]);
    }
    const doc = loan(store);
    expect(doc["totalPayablePesos"]).toBe(53_656);
    expect(doc["interestPesos"]).toBe(1_156);
  });

  it("audita LOAN_DISBURSED con la referencia y quien confirma", async () => {
    const { db, store } = await iniciado();

    await confirmLoanDisbursement(
      { db },
      { loanId: "loan-1", actor: { uid: "admin-2", role: Role.ADMIN }, idempotencyKey: "k2" },
    );

    const registros = audits(store, AuditAction.LOAN_DISBURSED);
    expect(registros).toHaveLength(1);
    expect(registros[0]!["actorId"]).toBe("admin-2");
    expect(registros[0]!["metadata"]).toMatchObject({
      fromStatus: LoanStatus.PENDING_DISBURSEMENT,
      toStatus: LoanStatus.DISBURSED,
      reference: "REF-1",
      rescheduledInstallments: 4,
      annualRateBps: 2_400,
      rateVersion: 1,
    });
  });

  it("replay no duplica la auditoria ni mueve las fechas otra vez", async () => {
    const { db, store } = await iniciado();
    const input = { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2" };

    const primero = await confirmLoanDisbursement({ db }, input);
    const fechas = [1, 2, 3, 4].map((n) => installment(store, n)["dueDate"]);
    const segundo = await confirmLoanDisbursement({ db }, input);

    expect(primero.replayed).toBe(false);
    expect(segundo.replayed).toBe(true);
    expect(segundo.rescheduledInstallments).toBe(4);
    expect(audits(store, AuditAction.LOAN_DISBURSED)).toHaveLength(1);
    expect([1, 2, 3, 4].map((n) => installment(store, n)["dueDate"])).toEqual(fechas);
  });

  it("no confirma dos veces con claves distintas", async () => {
    const { db, store } = await iniciado();
    await confirmLoanDisbursement({ db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2" });

    await expect(
      confirmLoanDisbursement({ db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k3" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(audits(store, AuditAction.LOAN_DISBURSED)).toHaveLength(1);
  });

  it("exige iniciar antes de confirmar", async () => {
    const { db } = setup();

    await expect(
      confirmLoanDisbursement(
        { db },
        { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2", reference: "REF-1" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("no confirma sin referencia: nunca automatico", async () => {
    const ctx = setup();
    await initiateLoanDisbursement(
      { db: ctx.db },
      { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k1" },
    );

    await expect(
      confirmLoanDisbursement({ db: ctx.db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(loan(ctx.store)["status"]).toBe(LoanStatus.PENDING_DISBURSEMENT);
    expect(ctx.store.read("disbursements", "loan-1")!["status"]).toBe("INITIATED");
  });

  it("acepta la referencia en la confirmacion si el inicio no la traia", async () => {
    const ctx = setup();
    await initiateLoanDisbursement(
      { db: ctx.db },
      { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k1" },
    );

    const result = await confirmLoanDisbursement(
      { db: ctx.db },
      { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2", reference: "REF-TARDIA" },
    );

    expect(result.reference).toBe("REF-TARDIA");
    expect(ctx.store.read("disbursements", "loan-1")!["reference"]).toBe("REF-TARDIA");
  });

  it("solo un administrador puede confirmar", async () => {
    const { db } = await iniciado();

    await expect(
      confirmLoanDisbursement({ db }, { loanId: "loan-1", actor: CUSTOMER, idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("un prestamo sin snapshot de pricing no se desembolsa (exige migracion)", async () => {
    const { db, store } = await iniciado({ sinPricing: true });

    await expect(
      confirmLoanDisbursement({ db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(loan(store)["status"]).toBe(LoanStatus.PENDING_DISBURSEMENT);
    expect(loan(store)["disbursedAt"]).toBeUndefined();
    expect(installment(store, 1)["dueDate"]).toEqual(addPeriods(APROBADO, TermFrequency.BIWEEKLY, 1));
    expect(audits(store, AuditAction.LOAN_DISBURSED)).toHaveLength(0);
  });

  it("no re-programa sobre cuotas que no cuadran con el prestamo", async () => {
    const Alteradas = CUOTAS.map((cuota, i) =>
      i === 0 ? { ...cuota, principalPesos: cuota.principalPesos + 1 } : cuota,
    );
    const { db, store } = await iniciado({ installments: Alteradas });

    await expect(
      confirmLoanDisbursement({ db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(loan(store)["status"]).toBe(LoanStatus.PENDING_DISBURSEMENT);
  });

  it("no toca el vencimiento de una cuota ya pagada", async () => {
    const conPagada = CUOTAS.map((cuota) =>
      cuota.installmentNumber === 1 ? { ...cuota, status: InstallmentStatus.PAID } : cuota,
    );
    const { db, store } = await iniciado({ installments: conPagada });
    const vencidaOriginal = installment(store, 1)["dueDate"];

    const result = await confirmLoanDisbursement(
      { db },
      { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2" },
    );

    expect(installment(store, 1)["dueDate"]).toEqual(vencidaOriginal);
    expect(result.rescheduledInstallments).toBe(3);
  });

  it("no re-programa si falta alguna cuota del prestamo", async () => {
    const { db, store } = await iniciado();
    store.remove("loan_installments", "loan-1_3");

    await expect(
      confirmLoanDisbursement({ db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(loan(store)["status"]).toBe(LoanStatus.PENDING_DISBURSEMENT);
    expect(audits(store, AuditAction.LOAN_DISBURSED)).toHaveLength(0);
  });

  it("no confirma un prestamo ya disbursado", async () => {
    const { db, store } = await iniciado();
    store.seed("loans", "loan-1", { status: LoanStatus.DISBURSED, loanNumber: "LOAN-0001" });

    await expect(
      confirmLoanDisbursement({ db }, { loanId: "loan-1", actor: ADMIN, idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
