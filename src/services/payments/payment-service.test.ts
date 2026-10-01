import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createFirestoreMock } from "@/test-utils/firestore-mock";
import {
  confirmPayment,
  createPayment,
  getPaymentForUser,
  rejectPayment,
  reversePayment,
  type PaymentActor,
} from "./payment-service";
import { AuditAction, DelinquencyStatus, InstallmentStatus, LoanStatus, PaymentStatus, Role } from "@/server/types";
import { PaymentChannelType } from "@/server/payment-doc";

const CLIENTE: PaymentActor = { uid: "uid-1", role: Role.CUSTOMER };
const ADMIN: PaymentActor = { uid: "admin-1", role: Role.ADMIN };
const AHORA = new Date("2026-03-24T00:00:00.000Z");

/** La cuota 1 vale 13.414 ya con una parte pagada: 10.000 - 2.500 = 7.500. */
function installment(overrides: Record<string, unknown> = {}) {
  return {
    loanId: "loan-1",
    installmentNumber: 1,
    dueDate: AHORA,
    principalPesos: 10_000,
    interestPesos: 2_000,
    feePesos: 1_414,
    totalPesos: 13_414,
    paidPesos: 0,
    status: InstallmentStatus.PENDING,
    ...overrides,
  };
}

function setup(overrides: { loanStatus?: LoanStatus; loanUserId?: string } = {}) {
  const { store, db } = createFirestoreMock();

  store.seed("loans", "loan-1", {
    loanNumber: "LOAN-0001",
    applicationId: "APP-1",
    userId: overrides.loanUserId ?? "uid-1",
    productCode: "MICRO_BASICO",
    principalPesos: 30_000,
    interestPesos: 2_000,
    feePesos: 1_000,
    totalPayablePesos: 33_000,
    status: overrides.loanStatus ?? LoanStatus.DISBURSED,
    outstandingPesos: 33_000,
    createdAt: AHORA,
    updatedAt: AHORA,
  });
  store.seed("loan_installments", "loan-1_1", installment());
  store.seed("loan_installments", "loan-1_2", installment({ installmentNumber: 2 }));
  store.seed("loan_installments", "loan-1_3", installment({ installmentNumber: 3 }));
  store.seed(
    "loan_installments",
    "loan-1_4",
    installment({ installmentNumber: 4, status: InstallmentStatus.PAID, paidPesos: 13_414 }),
  );

  // Préstamo y cuota de otro cliente, para probar que no se tocan.
  store.seed("loans", "loan-2", {
    loanNumber: "LOAN-0002",
    applicationId: "APP-2",
    userId: "uid-2",
    productCode: "MICRO_BASICO",
    principalPesos: 30_000,
    interestPesos: 2_000,
    feePesos: 1_000,
    totalPayablePesos: 33_000,
    status: LoanStatus.DISBURSED,
    createdAt: AHORA,
    updatedAt: AHORA,
  });
  store.seed("loan_installments", "loan-2_1", installment({ loanId: "loan-2" }));

  store.seed("payment_channels", PaymentChannelType.BANK_TRANSFER, {
    name: "Transferencia bancaria",
    type: PaymentChannelType.BANK_TRANSFER,
    instructionsText: "Transfiere a la cuenta registrada y digita la referencia.",
    meta: {},
    isActive: true,
    createdAt: AHORA,
    updatedAt: AHORA,
  });
  store.seed("payment_channels", PaymentChannelType.NEQUI, {
    name: "Nequi",
    type: PaymentChannelType.NEQUI,
    instructionsText: "Paga por Nequi y digita la referencia del pago.",
    meta: {},
    isActive: false,
    createdAt: AHORA,
    updatedAt: AHORA,
  });

  return { db: db as Firestore, store };
}

function pago(overrides: Partial<Parameters<typeof createPayment>[1]> = {}) {
  return {
    loanId: "loan-1",
    installmentId: "loan-1_1",
    channel: PaymentChannelType.BANK_TRANSFER,
    actor: CLIENTE,
    idempotencyKey: "k-1",
    ...overrides,
  };
}

function audits(store: ReturnType<typeof createFirestoreMock>["store"], action: string) {
  return store.list("audit_logs").filter((row) => row["action"] === action);
}

/** El año que va a usar el servicio, que es el del reloj del proceso. */
function numeroEsperado(consecutivo: number): string {
  return `PAY-${new Date().getFullYear()}-${consecutivo.toString().padStart(4, "0")}`;
}

describe("createPayment", () => {
  it("crea el pago PENDING con el saldo de la cuota y deja el rastro completo", async () => {
    const { db, store } = setup();

    const result = await createPayment({ db }, pago());

    expect(result.status).toBe(PaymentStatus.PENDING);
    expect(result.amountPesos).toBe(13_414);
    expect(result.replayed).toBe(false);
    expect(result.paymentNumber).toBe(numeroEsperado(1));
    expect(result.paymentId).toBe(result.paymentNumber);
    // El pago existe, pero la cuota no se movió: confirmar es un acto humano de F10-2b.
    expect(result.installmentStatus).toBe(InstallmentStatus.PENDING);

    const doc = store.read("payments", result.paymentId)!;
    expect(doc["status"]).toBe(PaymentStatus.PENDING);
    expect(doc["amountPesos"]).toBe(13_414);
    expect(doc["userId"]).toBe("uid-1");
    expect(doc["currency"]).toBe("COP");
    expect(doc["idempotencyKey"]).toBe("k-1");
    expect(doc["confirmedBy"]).toBeUndefined();
    expect(doc["confirmedAt"]).toBeUndefined();
    expect(doc["paidAt"]).toBeUndefined();

    // Candado de la cuota.
    expect(store.read("loan_installments", "loan-1_1")!["pendingPaymentId"]).toBe(result.paymentId);
    // Ni la cuota ni el préstamo se dieron por pagados.
    expect(store.read("loan_installments", "loan-1_1")!["paidPesos"]).toBe(0);
    expect(store.read("loans", "loan-1")!["outstandingPesos"]).toBe(33_000);
    expect(store.read("loans", "loan-1")!["status"]).toBe(LoanStatus.DISBURSED);

    const audit = audits(store, AuditAction.PAYMENT_CREATED);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: "uid-1",
      actorRole: Role.CUSTOMER,
      entityType: "payment",
      entityId: result.paymentId,
    });
    expect(audit[0]!["metadata"]).toMatchObject({
      loanId: "loan-1",
      installmentId: "loan-1_1",
      amountPesos: 13_414,
      status: PaymentStatus.PENDING,
    });
  });

  it("el importe lo decide el servidor: un amountPesos en el request se ignora", async () => {
    const { db, store } = setup();
    const manipulado = { ...pago(), amountPesos: 1 } as Parameters<typeof createPayment>[1];

    const result = await createPayment({ db }, manipulado);

    expect(result.amountPesos).toBe(13_414);
    expect(store.read("payments", result.paymentId)!["amountPesos"]).toBe(13_414);
  });

  it("paga el saldo pendiente, no el total, de una cuota con pagos parciales", async () => {
    const { db, store } = setup();
    store.seed("loan_installments", "loan-1_1", installment({ paidPesos: 2_500 }));

    const result = await createPayment({ db }, pago());

    expect(result.amountPesos).toBe(10_914);
  });

  it("doble POST con la misma clave devuelve el mismo pago y no duplica nada", async () => {
    const { db, store } = setup();

    const primero = await createPayment({ db }, pago());
    const segundo = await createPayment({ db }, pago());

    expect(segundo.paymentId).toBe(primero.paymentId);
    expect(segundo.replayed).toBe(true);
    expect(primero.replayed).toBe(false);
    expect(store.ids("payments")).toEqual([primero.paymentId]);
    expect(audits(store, AuditAction.PAYMENT_CREATED)).toHaveLength(1);
  });

  it("una clave distinta es otra operación, y el candado de la cuota la frena", async () => {
    const { db, store } = setup();
    await createPayment({ db }, pago());

    await expect(createPayment({ db }, pago({ idempotencyKey: "k-2" }))).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(store.ids("payments")).toHaveLength(1);
  });

  it("numera de forma consecutiva dentro del mismo año", async () => {
    const { db } = setup();

    const primero = await createPayment({ db }, pago());
    const segundo = await createPayment({ db }, pago({ installmentId: "loan-1_2", idempotencyKey: "k-2" }));

    expect(primero.paymentNumber).toBe(numeroEsperado(1));
    expect(segundo.paymentNumber).toBe(numeroEsperado(2));
  });

  it("la query del consecutivo solo usa rangos de un campo, sin indice compuesto", async () => {
    const { db, store } = setup();
    store.queries.length = 0;

    await createPayment({ db }, pago());

    const queries = store.queries.filter((q) => q.collection === "payments");
    expect(queries).toHaveLength(1);
    for (const query of queries) {
      // `where(paymentNumber) + orderBy(paymentNumber)`: el mismo campo, lo resuelve el indice
      // simple. Si algún día el filtro cae en otro campo, esto avisa (trampa de F9-2).
      for (const filtro of query.filters) {
        expect(
          query.order === null || filtro.field === query.order.field,
          `where + orderBy en campos distintos: ${JSON.stringify(query)}`,
        ).toBe(true);
      }
    }
  });

  it("404 tanto si el préstamo no existe como si es de otro cliente", async () => {
    const { db } = setup();

    await expect(createPayment({ db }, pago({ loanId: "no-existe" }))).rejects.toMatchObject({
      statusCode: 404,
      message: "Préstamo no encontrado",
    });
    await expect(createPayment({ db }, pago({ loanId: "loan-2" }))).rejects.toMatchObject({
      statusCode: 404,
      message: "Préstamo no encontrado",
    });
  });

  it("no deja pagar la cuota de otro préstamo", async () => {
    const { db } = setup();

    await expect(
      createPayment({ db }, pago({ loanId: "loan-1", installmentId: "loan-2_1" })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404 si la cuota no existe", async () => {
    const { db } = setup();

    await expect(createPayment({ db }, pago({ installmentId: "loan-1_9" }))).rejects.toMatchObject({
      statusCode: 404,
      message: "Cuota no encontrada",
    });
  });

  it("no deja pagar una cuota ya pagada ni una sin saldo", async () => {
    const { db } = setup();

    await expect(createPayment({ db }, pago({ installmentId: "loan-1_4" }))).rejects.toMatchObject({
      statusCode: 409,
    });
    const { store } = setup();
    store.seed("loan_installments", "loan-1_1", installment({ paidPesos: 13_414 }));
    await expect(createPayment({ db: store.asFirestore() }, pago())).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("rechaza pagar un préstamo que no ha salido o que ya está saldado", async () => {
    const pendiente = setup({ loanStatus: LoanStatus.PENDING_DISBURSEMENT });
    await expect(createPayment({ db: pendiente.db }, pago())).rejects.toMatchObject({ statusCode: 409 });

    const saldado = setup({ loanStatus: LoanStatus.PAID });
    await expect(createPayment({ db: saldado.db }, pago())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("exige un canal existente y activo", async () => {
    const { db } = setup();

    await expect(createPayment({ db }, pago({ channel: "CANAL_FALSO" }))).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(createPayment({ db }, pago({ channel: PaymentChannelType.NEQUI }))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("exige Idempotency-Key y un cliente como actor", async () => {
    const { db } = setup();

    await expect(createPayment({ db }, pago({ idempotencyKey: "" }))).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(createPayment({ db }, pago({ actor: ADMIN }))).rejects.toMatchObject({ statusCode: 403 });
  });

  it("no escribe nada cuando falla: ni pago, ni candado, ni auditoría", async () => {
    const { db, store } = setup();

    await expect(createPayment({ db }, pago({ installmentId: "loan-1_4" }))).rejects.toMatchObject({
      statusCode: 409,
    });

    expect(store.ids("payments")).toEqual([]);
    expect(store.read("loan_installments", "loan-1_4")!["pendingPaymentId"]).toBeUndefined();
    expect(audits(store, AuditAction.PAYMENT_CREATED)).toHaveLength(0);
  });
});

describe("getPaymentForUser", () => {
  it("devuelve el pago del propio cliente", async () => {
    const { db } = setup();
    const creado = await createPayment({ db }, pago());

    const visto = await getPaymentForUser({ db }, { paymentId: creado.paymentId, userId: "uid-1" });

    expect(visto.paymentId).toBe(creado.paymentId);
    expect(visto.amountPesos).toBe(13_414);
    expect(visto.createdAt).toBeInstanceOf(Date);
  });

  it("404 para un pago de otro cliente o inexistente (no revela cuál de las dos)", async () => {
    const { db } = setup();
    const creado = await createPayment({ db }, pago());

    await expect(
      getPaymentForUser({ db }, { paymentId: creado.paymentId, userId: "uid-2" }),
    ).rejects.toMatchObject({ statusCode: 404, message: "Pago no encontrado" });
    await expect(
      getPaymentForUser({ db }, { paymentId: "PAY-2020-0001", userId: "uid-1" }),
    ).rejects.toMatchObject({ statusCode: 404, message: "Pago no encontrado" });
  });
});

/** ==================== Resolución por ADMIN (F10-2b) ==================== */

const PRICING = {
  annualRateBps: 5_800,
  effectiveFeeBps: 0,
  rateVersion: 1,
  termInstallments: 3,
  termFrequency: "WEEKLY",
};

/** Días atrás (adelante si negativo) a medianoche UTC, relativos al reloj real del proceso. */
function hace(dias: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - dias);
  return d;
}

function en(dias: number): Date {
  return hace(-dias);
}

function cuota(n: number, dueDate: Date) {
  return {
    loanId: "loan-1",
    installmentNumber: n,
    dueDate,
    principalPesos: 10_000,
    interestPesos: 2_000,
    feePesos: 1_414,
    totalPesos: 13_414,
    paidPesos: 0,
    status: InstallmentStatus.PENDING,
  };
}

/**
 * Préstamo de 3 cuotas con vencimientos relativos al reloj del proceso:
 * cuota 1 lleva 2 días de atraso (OVERDUE), cuota 2 vence en 3 días (DUE_SOON) y cuota 3 en 10
 * (CURRENT). Así los recálculos de mora son deterministas pese a que el servicio usa `new Date()`.
 */
function setupAdmin() {
  const { store, db } = createFirestoreMock();

  store.seed("loans", "loan-1", {
    loanNumber: "LOAN-0001",
    applicationId: "APP-1",
    userId: "uid-1",
    productCode: "MICRO_BASICO",
    principalPesos: 30_000,
    interestPesos: 6_000,
    feePesos: 3_414,
    totalPayablePesos: 40_242,
    pricing: PRICING,
    status: LoanStatus.DISBURSED,
    outstandingPesos: 40_242,
    createdAt: AHORA,
    updatedAt: AHORA,
  });
  store.seed("loan_installments", "loan-1_1", cuota(1, hace(2)));
  store.seed("loan_installments", "loan-1_2", cuota(2, en(3)));
  store.seed("loan_installments", "loan-1_3", cuota(3, en(10)));
  store.seed("system_config", "delinquency", {
    value: { dueSoonDays: 3, overdueDays: 1, defaultDays: 30 },
    updatedBy: "admin-0",
    updatedAt: AHORA,
  });
  store.seed("payment_channels", PaymentChannelType.BANK_TRANSFER, {
    name: "Transferencia bancaria",
    type: PaymentChannelType.BANK_TRANSFER,
    instructionsText: "Transfiere a la cuenta registrada y digita la referencia.",
    meta: {},
    isActive: true,
    createdAt: AHORA,
    updatedAt: AHORA,
  });

  return { db: db as Firestore, store };
}

function resolveInput(paymentId: string, idempotencyKey: string, extra: Record<string, unknown> = {}) {
  return { paymentId, actor: ADMIN, idempotencyKey, ...extra };
}

async function crearPagoSobre(db: Firestore, installmentId: string, idempotencyKey: string) {
  return createPayment({ db }, pago({ installmentId, idempotencyKey }));
}

describe("confirmPayment", () => {
  it("confirma el pago, salda la cuota y recalcula saldo y mora", async () => {
    const { db, store } = setupAdmin();
    const creado = await crearPagoSobre(db, "loan-1_1", "k-1");

    const resultado = await confirmPayment({ db }, resolveInput(creado.paymentId, "c-1"));

    expect(resultado.status).toBe(PaymentStatus.CONFIRMED);
    expect(resultado.replayed).toBe(false);
    expect(resultado.loan).toMatchObject({
      outstandingPesos: 26_828,
      daysPastDue: 0,
      delinquencyStatus: DelinquencyStatus.DUE_SOON,
    });

    const cuotaEscr = store.read("loan_installments", "loan-1_1")!;
    expect(cuotaEscr["status"]).toBe(InstallmentStatus.PAID);
    expect(cuotaEscr["paidPesos"]).toBe(13_414);
    expect(cuotaEscr["paymentId"]).toBe(creado.paymentId);
    expect(cuotaEscr["pendingPaymentId"]).toBeUndefined();
    expect(cuotaEscr["paidAt"]).toBeDefined();

    const loan = store.read("loans", "loan-1")!;
    expect(loan["outstandingPesos"]).toBe(26_828);
    expect(loan["delinquencyStatus"]).toBe(DelinquencyStatus.DUE_SOON);
    expect(loan["daysPastDue"]).toBe(0);
    expect(loan["status"]).toBe(LoanStatus.DISBURSED);

    const evento = store.read("payment_events", `${creado.paymentId}_1`);
    expect(evento).toBeDefined();
    expect(evento!["fromStatus"]).toBe(PaymentStatus.PENDING);
    expect(evento!["toStatus"]).toBe(PaymentStatus.CONFIRMED);
    expect(audits(store, AuditAction.PAYMENT_CONFIRMED)).toHaveLength(1);
  });

  it("el último pago salda el préstamo: PAID con fecha", async () => {
    const { db, store } = setupAdmin();
    const p1 = await crearPagoSobre(db, "loan-1_1", "k-1");
    const p2 = await crearPagoSobre(db, "loan-1_2", "k-2");
    expect((await confirmPayment({ db }, resolveInput(p1.paymentId, "c-1"))).status).toBe(PaymentStatus.CONFIRMED);
    expect((await confirmPayment({ db }, resolveInput(p2.paymentId, "c-2"))).status).toBe(PaymentStatus.CONFIRMED);

    const p3 = await crearPagoSobre(db, "loan-1_3", "k-3");
    const resultado = await confirmPayment({ db }, resolveInput(p3.paymentId, "c-3"));

    expect(resultado.loan).toMatchObject({
      outstandingPesos: 0,
      daysPastDue: 0,
      delinquencyStatus: DelinquencyStatus.PAID,
      status: LoanStatus.PAID,
    });
    expect(store.read("loans", "loan-1")!["paidAt"]).toBeDefined();
  });

  it("idempotente: la misma clave no repite la transición", async () => {
    const { db, store } = setupAdmin();
    const creado = await crearPagoSobre(db, "loan-1_1", "k-1");

    const primero = await confirmPayment({ db }, resolveInput(creado.paymentId, "c-1"));
    const segundo = await confirmPayment({ db }, resolveInput(creado.paymentId, "c-1"));

    expect(primero.replayed).toBe(false);
    expect(segundo.replayed).toBe(true);
    expect(segundo.status).toBe(PaymentStatus.CONFIRMED);
    expect(store.read("payment_events", `${creado.paymentId}_1`)).toBeDefined();
    expect(store.ids("payment_events")).toHaveLength(1);
    expect(audits(store, AuditAction.PAYMENT_CONFIRMED)).toHaveLength(1);
  });

  it("con otra clave no se confirma dos veces", async () => {
    const { db } = setupAdmin();
    const creado = await crearPagoSobre(db, "loan-1_1", "k-1");

    await confirmPayment({ db }, resolveInput(creado.paymentId, "c-1"));
    await expect(confirmPayment({ db }, resolveInput(creado.paymentId, "c-2"))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("una cuota cuyo candado pasó a otro pago no se confirma", async () => {
    const { db, store } = setupAdmin();
    const creado = await crearPagoSobre(db, "loan-1_1", "k-1");
    // Simula que otro flujo soltó el candado de la cuota (rechazo manual, depuración, etc.).
    store.seed("loan_installments", "loan-1_1", cuota(1, hace(2)));

    await expect(confirmPayment({ db }, resolveInput(creado.paymentId, "c-1"))).rejects.toMatchObject({
      statusCode: 409,
      message: /ya no espera el pago/,
    });
  });

  it("solo ADMIN y con la clave y el id correctos", async () => {
    const { db } = setupAdmin();
    const creado = await crearPagoSobre(db, "loan-1_1", "k-1");

    await expect(confirmPayment({ db }, resolveInput(creado.paymentId, ""))).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      confirmPayment({ db }, { paymentId: creado.paymentId, actor: CLIENTE, idempotencyKey: "c-1" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(confirmPayment({ db }, resolveInput("no-existe", "c-1"))).rejects.toMatchObject({
      statusCode: 404,
      message: "Pago no encontrado",
    });
  });
});

describe("rejectPayment", () => {
  it("rechaza el pago, suelta el candado y deja el rastro auditable", async () => {
    const { db, store } = setupAdmin();
    const creado = await crearPagoSobre(db, "loan-1_1", "k-1");

    const resultado = await rejectPayment(
      { db },
      resolveInput(creado.paymentId, "r-1", { reason: "Referencia no coincide" }),
    );

    expect(resultado.status).toBe(PaymentStatus.REJECTED);
    expect(resultado.reason).toBe("Referencia no coincide");
    // La cuota queda sin candado y sin moverse del estado en que estaba.
    expect(store.read("loan_installments", "loan-1_1")!["pendingPaymentId"]).toBeUndefined();
    expect(store.read("loan_installments", "loan-1_1")!["status"]).toBe(InstallmentStatus.PENDING);
    // El préstamo no se tocó.
    expect(store.read("loans", "loan-1")!["outstandingPesos"]).toBe(40_242);

    const evento = store.read("payment_events", `${creado.paymentId}_1`);
    expect(evento!["toStatus"]).toBe(PaymentStatus.REJECTED);
    expect(audits(store, AuditAction.PAYMENT_REJECTED)).toHaveLength(1);
  });

  it("al rechazar, la cuota vuelve a aceptar un pago nuevo", async () => {
    const { db } = setupAdmin();
    const primero = await crearPagoSobre(db, "loan-1_1", "k-1");
    await rejectPayment({ db }, resolveInput(primero.paymentId, "r-1", { reason: "Mal referenciado" }));

    const segundo = await crearPagoSobre(db, "loan-1_1", "k-2");

    expect(segundo.paymentId).not.toBe(primero.paymentId);
    expect(segundo.status).toBe(PaymentStatus.PENDING);
  });

  it("exige motivo y no rechaza un pago ya confirmado", async () => {
    const { db } = setupAdmin();
    const pendiente = await crearPagoSobre(db, "loan-1_2", "k-2");
    await expect(
      rejectPayment({ db }, resolveInput(pendiente.paymentId, "r-0", { reason: "  " })),
    ).rejects.toMatchObject({ statusCode: 400 });

    const creado = await crearPagoSobre(db, "loan-1_1", "k-1");
    await confirmPayment({ db }, resolveInput(creado.paymentId, "c-1"));
    await expect(
      rejectPayment({ db }, resolveInput(creado.paymentId, "r-2", { reason: "Ya confirmado" })),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("retry con la misma clave es replay, no un segundo rechazo", async () => {
    const { db, store } = setupAdmin();
    const creado = await crearPagoSobre(db, "loan-1_1", "k-1");

    const primero = await rejectPayment({ db }, resolveInput(creado.paymentId, "r-1", { reason: "X" }));
    const segundo = await rejectPayment({ db }, resolveInput(creado.paymentId, "r-1", { reason: "X" }));

    expect(primero.replayed).toBe(false);
    expect(segundo.replayed).toBe(true);
    expect(store.ids("payment_events")).toHaveLength(1);
    expect(audits(store, AuditAction.PAYMENT_REJECTED)).toHaveLength(1);
  });
});

describe("reversePayment", () => {
  it("revierte un pago confirmado: la cuota vuelve a PENDING y el saldo se restaura", async () => {
    const { db, store } = setupAdmin();
    const creado = await crearPagoSobre(db, "loan-1_1", "k-1");
    await confirmPayment({ db }, resolveInput(creado.paymentId, "c-1"));

    const resultado = await reversePayment(
      { db },
      resolveInput(creado.paymentId, "v-1", { reason: "El banco devolvió la transferencia" }),
    );

    expect(resultado.status).toBe(PaymentStatus.REVERSED);
    expect(resultado.loan).toMatchObject({
      outstandingPesos: 40_242,
      daysPastDue: 2,
      delinquencyStatus: DelinquencyStatus.OVERDUE,
      status: LoanStatus.DISBURSED,
    });

    const cuotaEscr = store.read("loan_installments", "loan-1_1")!;
    expect(cuotaEscr["status"]).toBe(InstallmentStatus.PENDING);
    expect(cuotaEscr["paidPesos"]).toBe(0);
    expect(cuotaEscr["paymentId"]).toBeUndefined();
    expect(cuotaEscr["paidAt"]).toBeUndefined();

    const evento = store.read("payment_events", `${creado.paymentId}_2`);
    expect(evento!["fromStatus"]).toBe(PaymentStatus.CONFIRMED);
    expect(evento!["toStatus"]).toBe(PaymentStatus.REVERSED);
    expect(audits(store, AuditAction.PAYMENT_REVERSED)).toHaveLength(1);
  });

  it("revierte un préstamo saldado y lo vuelve a activar", async () => {
    const { db, store } = setupAdmin();
    const p1 = await crearPagoSobre(db, "loan-1_1", "k-1");
    const p2 = await crearPagoSobre(db, "loan-1_2", "k-2");
    const p3 = await crearPagoSobre(db, "loan-1_3", "k-3");
    await confirmPayment({ db }, resolveInput(p1.paymentId, "c-1"));
    await confirmPayment({ db }, resolveInput(p2.paymentId, "c-2"));
    await confirmPayment({ db }, resolveInput(p3.paymentId, "c-3"));
    expect(store.read("loans", "loan-1")!["status"]).toBe(LoanStatus.PAID);

    await reversePayment({ db }, resolveInput(p3.paymentId, "v-3", { reason: "Devolución del banco" }));

    const loan = store.read("loans", "loan-1")!;
    expect(loan["status"]).toBe(LoanStatus.DISBURSED);
    expect(loan["paidAt"]).toBeUndefined();
    expect(loan["outstandingPesos"]).toBe(13_414);
  });

  it("no reversa un pago que no está confirmado", async () => {
    const { db } = setupAdmin();
    const creado = await crearPagoSobre(db, "loan-1_1", "k-1");

    await expect(
      reversePayment({ db }, resolveInput(creado.paymentId, "v-1", { reason: "Antes de confirmar" })),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
