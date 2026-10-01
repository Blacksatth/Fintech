import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createFirestoreMock, type InMemoryFirestore } from "@/test-utils/firestore-mock";
import { createInAppProvider } from "@/services/notifications/notification-service";
import {
  listDelinquencyForAdmin,
  recalcActivePortfolio,
  recalcLoanDelinquencyNow,
} from "./delinquency-service";
import { DelinquencyStatus, AuditAction, LoanStatus, TermFrequency } from "@/server/types";
import { NotificationType } from "@/server/notification-doc";

/**
 * Escenario (todos los vencimientos a medianoche UTC, que es como los escribe el calendario):
 *
 * - `loan-al-dia`: 2 cuotas, la primera vence en 10 días → `CURRENT`.
 * - `loan-proxima`: 1 cuota que vence en 2 días (dentro de `dueSoonDays: 3`) → `DUE_SOON`.
 * - `loan-vencida`: 1 cuota vencida hace 5 días → `OVERDUE`.
 * - `loan-incumplida`: 2 cuotas, la primera vencida hace 40 días (`>= defaultDays: 30`) → `DEFAULT`.
 * - `loan-saldado`: `PAID` → no aparece: la cartera de mora son los activos.
 * - `loan-sin-pricing`: `DISBURSED` sin snapshot → fila con `error`, no tumba la cartera.
 */
const HOY = new Date("2026-03-24T12:00:00.000Z");

function dia(offset: number): Date {
  return new Date(Date.UTC(2026, 2, 24 + offset));
}

const CUOTA = { principalPesos: 25_000, interestPesos: 0, feePesos: 0 };

function loan(id: string, status: LoanStatus, termInstallments: number, extra: Record<string, unknown> = {}) {
  return {
    loanNumber: `LOAN-${id.toUpperCase()}`,
    applicationId: "APP-1",
    userId: `uid-${id}`,
    productCode: "MICRO_BASICO",
    principalPesos: 25_000 * termInstallments,
    interestPesos: 0,
    feePesos: 0,
    totalPayablePesos: 25_000 * termInstallments,
    pricing: {
      annualRateBps: 0,
      effectiveFeeBps: 0,
      rateVersion: 1,
      termInstallments,
      termFrequency: TermFrequency.BIWEEKLY,
    },
    status,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...extra,
  };
}

function installment(loanId: string, n: number, dueDate: Date, paidPesos = 0) {
  return {
    loanId,
    installmentNumber: n,
    dueDate,
    ...CUOTA,
    totalPesos: 25_000,
    paidPesos,
    status: paidPesos >= 25_000 ? "PAID" : "PENDING",
  };
}

function setup() {
  const { store, db } = createFirestoreMock();
  store.seed("system_config", "delinquency", {
    value: { dueSoonDays: 3, overdueDays: 1, defaultDays: 30 },
    updatedBy: "seed",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  store.seed("loans", "loan-al-dia", loan("al-dia", LoanStatus.DISBURSED, 2));
  store.seed("loan_installments", "loan-al-dia_1", installment("loan-al-dia", 1, dia(10)));
  store.seed("loan_installments", "loan-al-dia_2", installment("loan-al-dia", 2, dia(24)));

  store.seed("loans", "loan-proxima", loan("proxima", LoanStatus.DISBURSED, 1));
  store.seed("loan_installments", "loan-proxima_1", installment("loan-proxima", 1, dia(2)));

  store.seed("loans", "loan-vencida", loan("vencida", LoanStatus.DISBURSED, 1));
  store.seed("loan_installments", "loan-vencida_1", installment("loan-vencida", 1, dia(-5)));

  store.seed("loans", "loan-incumplida", loan("incumplida", LoanStatus.DISBURSED, 2));
  store.seed("loan_installments", "loan-incumplida_1", installment("loan-incumplida", 1, dia(-40)));
  store.seed("loan_installments", "loan-incumplida_2", installment("loan-incumplida", 2, dia(-26)));

  store.seed("loans", "loan-saldado", loan("saldado", LoanStatus.PAID, 1));
  store.seed("loan_installments", "loan-saldado_1", installment("loan-saldado", 1, dia(-60), 25_000));

  store.seed("loans", "loan-sin-pricing", {
    loanNumber: "LOAN-SIN-PRICING",
    userId: "uid-sin-pricing",
    principalPesos: 30_000,
    status: LoanStatus.DISBURSED,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  for (const uid of ["uid-al-dia", "uid-proxima", "uid-vencida", "uid-incumplida", "uid-sin-pricing"]) {
    store.seed("users", uid, { email: `${uid}@local.dev`, fullName: `Titular ${uid}`, role: "CUSTOMER" });
  }

  return { db: db as Firestore, store, deps: { db: db as Firestore, notifyProviders: [createInAppProvider({ db })] } };
}

function estados(store: InMemoryFirestore, loanId: string) {
  return store.read("loans", loanId);
}

describe("listDelinquencyForAdmin", () => {
  it("recalcula en vuelo y ordena por atraso, sin escribir nada", async () => {
    const { db, store, deps } = setup();

    const { rows } = await listDelinquencyForAdmin(deps, { today: HOY });

    expect(rows.map((row) => row.loanId)).toEqual([
      "loan-incumplida",
      "loan-vencida",
      "loan-proxima",
      "loan-al-dia",
      "loan-sin-pricing",
    ]);
    expect(rows[0].recalc?.delinquencyStatus).toBe(DelinquencyStatus.DEFAULT);
    expect(rows[0].recalc?.daysPastDue).toBe(40);
    // La lectura en fresco no toca la colección: los docs siguen sin caché.
    expect(estados(store, "loan-incumplida")?.["delinquencyStatus"]).toBeUndefined();
    expect(estados(store, "loan-incumplida")?.["updatedAt"]).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(db.collection("loans")).toBeDefined();
  });

  it("el resumen sale de los recalculados, no de la caché", async () => {
    const { deps } = setup();

    const { summary } = await listDelinquencyForAdmin(deps, { today: HOY });

    expect(summary.loans).toBe(4);
    expect(summary.outstandingPesos).toBe(150_000); // al día 50k + próxima 25k + vencida 25k + incumplida 50k
    expect(summary.overduePesos).toBe(75_000); // vencida + incumplida
    expect(summary.inDefaultPesos).toBe(50_000);
    expect(summary.dueSoonPesos).toBe(25_000);
    expect(summary.maxDaysPastDue).toBe(40);
    expect(summary.byStatus).toEqual({
      CURRENT: 1,
      DUE_SOON: 1,
      DUE_TODAY: 0,
      OVERDUE: 1,
      DEFAULT: 1,
      PAID: 0,
    });
  });

  it("filtra por el estado recalculado, no por la caché guardada", async () => {
    const { store, deps } = setup();
    // La caché dice lo contrario a propósito: el filtro debe ganar al dato viejo.
    store.seed("loans", "loan-vencida", loan("vencida", LoanStatus.DISBURSED, 1, { delinquencyStatus: "CURRENT" }));
    store.seed("loan_installments", "loan-vencida_1", installment("loan-vencida", 1, dia(-5)));

    const { rows } = await listDelinquencyForAdmin(deps, {
      today: HOY,
      filter: { status: DelinquencyStatus.OVERDUE },
    });

    expect(rows.map((row) => row.loanId)).toEqual(["loan-vencida"]);
  });

  it("un préstamo que no se puede calcular no tumba la cartera", async () => {
    const { deps } = setup();

    const { rows, summary } = await listDelinquencyForAdmin(deps, { today: HOY });

    const roto = rows.find((row) => row.loanId === "loan-sin-pricing");
    expect(roto?.recalc).toBeNull();
    expect(roto?.error).toContain("pricing");
    expect(summary.loans).toBe(4);
  });

  it("trae el titular y la próxima cuota impaga", async () => {
    const { deps } = setup();

    const { rows } = await listDelinquencyForAdmin(deps, { today: HOY });
    const vencida = rows.find((row) => row.loanId === "loan-vencida");

    expect(vencida?.holder?.fullName).toBe("Titular uid-vencida");
    expect(vencida?.nextInstallment?.installmentNumber).toBe(1);
    expect(vencida?.nextInstallmentDaysPastDue).toBe(5);
  });

  it("solo consulta con igualdad de un campo: ningún orderBy cruzado (índice compuesto)", async () => {
    const { store, deps } = setup();

    await listDelinquencyForAdmin(deps, { today: HOY });

    const loansQueries = store.queries.filter((q) => q.collection === "loans");
    expect(loansQueries.length).toBeGreaterThan(0);
    for (const query of loansQueries) {
      expect(query.order).toBeNull();
      expect(query.filters).toHaveLength(1);
    }
  });

  it("sin `system_config/delinquency` falla en vez de inventar umbrales", async () => {
    const { store, deps } = setup();
    store.remove("system_config", "delinquency");

    await expect(listDelinquencyForAdmin(deps, { today: HOY })).rejects.toThrow(RangeError);
  });
});

describe("recalcActivePortfolio", () => {
  it("escribe la caché de lo que cambió y deja auditoría de la pasada", async () => {
    const { store, deps } = setup();

    const summary = await recalcActivePortfolio(deps, { uid: "admin-1", role: "ADMIN" }, HOY);

    expect(summary.evaluated).toBe(5);
    expect(summary.updated).toBe(4);
    expect(summary.failed).toEqual([
      { loanId: "loan-sin-pricing", reason: expect.stringContaining("pricing") },
    ]);
    expect(estados(store, "loan-incumplida")).toMatchObject({
      delinquencyStatus: "DEFAULT",
      daysPastDue: 40,
      outstandingPesos: 50_000,
    });
    expect(estados(store, "loan-vencida")).toMatchObject({
      delinquencyStatus: "OVERDUE",
      daysPastDue: 5,
      outstandingPesos: 25_000,
    });
    const audit = store.list("audit_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: "admin-1",
      action: AuditAction.DELINQUENCY_RECALCULATED,
      entityType: "portfolio",
    });
  });

  it("avisa una vez por cuota vencida o próxima y no repite al reavisar", async () => {
    const { store, deps } = setup();

    const primera = await recalcActivePortfolio(deps, { uid: "admin-1", role: "ADMIN" }, HOY);
    const segunda = await recalcActivePortfolio(deps, { uid: "admin-1", role: "ADMIN" }, HOY);

    // vencida + incumplida (OVERDUE) + próxima (DUE_SOON). Las cuotas que vencen dentro de más
    // de 3 días no se avisan: la ventana sale de `dueSoonDays`, no de un número escrito aquí.
    expect(primera.notificationsCreated).toBe(3);
    expect(segunda.notificationsCreated).toBe(0);
    expect(segunda.notificationsSkipped).toBe(3);
    expect(segunda.updated).toBe(0);

    const avisos = store.list("notifications");
    expect(avisos).toHaveLength(3);
    const porTipo = avisos.map((doc) => doc["type"]).sort();
    expect(porTipo).toEqual(
      [
        NotificationType.INSTALLMENT_DUE_SOON,
        NotificationType.INSTALLMENT_OVERDUE,
        NotificationType.INSTALLMENT_OVERDUE,
      ].sort(),
    );
    const vencida = avisos.find(
      (doc) => doc["type"] === NotificationType.INSTALLMENT_OVERDUE && doc["userId"] === "uid-vencida",
    );
    expect(vencida?.["userId"]).toBe("uid-vencida");
    expect(vencida?.["body"]).toContain("5 días de atraso");
    expect(vencida?.["payload"]).toMatchObject({
      loanId: "loan-vencida",
      installmentId: "loan-vencida_1",
      amountPesos: 25_000,
      daysPastDue: 5,
    });
  });

  it("saldar el préstamo por pagos lo pasa a PAID con su fecha; el día siguiente no lo toca", async () => {
    const { store, deps } = setup();
    for (const cuota of [1, 2]) {
      store.seed(
        "loan_installments",
        `loan-al-dia_${cuota}`,
        installment("loan-al-dia", cuota, dia(10 + 14 * cuota), 25_000),
      );
    }

    const resumen = await recalcActivePortfolio(deps, { uid: "admin-1", role: "ADMIN" }, HOY);
    const despues = new Date("2026-03-25T12:00:00.000Z");
    const segunda = await recalcActivePortfolio(deps, { uid: "admin-1", role: "ADMIN" }, despues);

    expect(resumen.summary.byStatus.PAID).toBe(1);
    expect(estados(store, "loan-al-dia")).toMatchObject({ status: "PAID", delinquencyStatus: "PAID" });
    expect((estados(store, "loan-al-dia")?.["paidAt"] as Date).toISOString()).toBe(HOY.toISOString());
    // Un día después solo cambian los que acumularon un día más de atraso (vencida e
    // incumplida): el saldado no se reescribe, porque no hay nada que recalcular en él.
    expect(segunda.updated).toBe(2);
    expect(estados(store, "loan-al-dia")?.["updatedAt"]).toBe(HOY);
  });
});

describe("recalcLoanDelinquencyNow", () => {
  it("escribe la caché del préstamo y dice si cambió", async () => {
    const { store, deps } = setup();

    const primera = await recalcLoanDelinquencyNow(deps, "loan-vencida", HOY);
    const segunda = await recalcLoanDelinquencyNow(deps, "loan-vencida", HOY);

    expect(primera.changed).toBe(true);
    expect(primera.row.recalc).toEqual({
      outstandingPesos: 25_000,
      daysPastDue: 5,
      delinquencyStatus: DelinquencyStatus.OVERDUE,
    });
    expect(segunda.changed).toBe(false);
    expect(estados(store, "loan-vencida")).toMatchObject({ daysPastDue: 5, outstandingPesos: 25_000 });
  });

  it("404 si el préstamo no existe", async () => {
    const { deps } = setup();

    await expect(recalcLoanDelinquencyNow(deps, "no-existe", HOY)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("409 si al préstamo le falta una cuota: no se recalcula sobre datos incompletos", async () => {
    const { store, deps } = setup();
    store.remove("loan_installments", "loan-proxima_1");

    await expect(recalcLoanDelinquencyNow(deps, "loan-proxima", HOY)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(estados(store, "loan-proxima")?.["delinquencyStatus"]).toBeUndefined();
  });
});
