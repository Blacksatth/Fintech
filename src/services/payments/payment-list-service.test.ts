import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createFirestoreMock } from "@/test-utils/firestore-mock";
import { InstallmentStatus, LoanStatus, PaymentStatus, Role, TermFrequency } from "@/server/types";
import { PaymentChannelType } from "@/server/payment-doc";
import { createPayment, type PaymentActor } from "./payment-service";
import { confirmPayment, rejectPayment } from "./payment-service";
import {
  ADMIN_PAYMENT_FILTERS,
  listPaymentsForAdmin,
  listPaymentsForLoan,
  type AdminPaymentListItem,
} from "./payment-list-service";

/**
 * Los listados son la parte de F10-4 que más fácil se rompe en silencio: un filtro mal puesto no
 * da error, muestra una lista incompleta. Estos tests miran que cada consulta devuelva exactamente
 * lo que pertenece a quien pregunta.
 */

const CLIENTE: PaymentActor = { uid: "uid-1", role: Role.CUSTOMER };
const OTRO: PaymentActor = { uid: "uid-2", role: Role.CUSTOMER };
const AHORA = new Date("2026-03-24T00:00:00.000Z");

function setup() {
  const { store, db } = createFirestoreMock();

  for (const [loanId, userId] of [
    ["loan-1", "uid-1"],
    ["loan-2", "uid-2"],
  ] as const) {
    store.seed("loans", loanId, {
      loanNumber: `LOAN-${loanId.toUpperCase()}`,
      applicationId: `APP-${loanId.toUpperCase()}`,
      userId,
      productCode: "MICRO_BASICO",
      principalPesos: 30_000,
      interestPesos: 6_000,
      feePesos: 3_414,
      totalPayablePesos: 40_242,
      pricing: {
        annualRateBps: 5_800,
        effectiveFeeBps: 0,
        rateVersion: 1,
        termInstallments: 2,
        termFrequency: TermFrequency.WEEKLY,
      },
      status: LoanStatus.DISBURSED,
      outstandingPesos: 40_242,
      createdAt: AHORA,
      updatedAt: AHORA,
    });
    for (const n of [1, 2]) {
      store.seed("loan_installments", `${loanId}_${n}`, {
        loanId,
        installmentNumber: n,
        dueDate: AHORA,
        principalPesos: 15_000,
        interestPesos: 3_000,
        feePesos: 1_707,
        totalPesos: 19_707,
        paidPesos: 0,
        status: InstallmentStatus.PENDING,
      });
    }
  }

  store.seed("system_config", "delinquency", {
    value: { dueSoonDays: 3, overdueDays: 1, defaultDays: 30 },
    updatedBy: "admin-0",
    updatedAt: AHORA,
  });

  store.seed("payment_channels", PaymentChannelType.BANK_TRANSFER, {
    name: "Transferencia bancaria",
    type: PaymentChannelType.BANK_TRANSFER,
    instructionsText: "Transfiere y digita la referencia.",
    meta: {},
    isActive: true,
    createdAt: AHORA,
    updatedAt: AHORA,
  });

  return { db: db as Firestore, store };
}

function pago(
  db: Firestore,
  input: { loanId: string; installmentId: string; actor: PaymentActor; key: string },
) {
  return createPayment(
    { db },
    {
      loanId: input.loanId,
      installmentId: input.installmentId,
      channel: PaymentChannelType.BANK_TRANSFER,
      reference: "REF-123",
      actor: input.actor,
      idempotencyKey: input.key,
    },
  );
}

/** Marca un pago como resuelto, sin importar cuál de las dos vías. */
async function resolver(db: Firestore, paymentId: string, forma: "confirm" | "reject") {
  const actor: PaymentActor = { uid: "admin-1", role: Role.ADMIN };
  const input = { paymentId, actor, idempotencyKey: `k-${paymentId}-${forma}` };
  return forma === "confirm"
    ? confirmPayment({ db }, input)
    : rejectPayment({ db }, { ...input, reason: "no llegó el dinero" });
}

function ids(items: Array<{ paymentId: string }>): string[] {
  return items.map((item) => item.paymentId);
}

describe("listPaymentsForLoan", () => {
  it("devuelve el historial del préstamo con el número y el estado de su cuota", async () => {
    const { db } = setup();
    const uno = await pago(db, { loanId: "loan-1", installmentId: "loan-1_1", actor: CLIENTE, key: "k1" });
    const dos = await pago(db, { loanId: "loan-1", installmentId: "loan-1_2", actor: CLIENTE, key: "k2" });

    const lista = await listPaymentsForLoan({ db }, { loanId: "loan-1", userId: "uid-1" });

    // El más reciente primero.
    expect(ids(lista)).toEqual([dos.paymentId, uno.paymentId]);
    expect(lista[0]).toMatchObject({
      paymentId: dos.paymentId,
      installmentNumber: 2,
      installmentStatus: InstallmentStatus.PENDING,
      amountPesos: 19_707,
      channel: PaymentChannelType.BANK_TRANSFER,
      reference: "REF-123",
      status: PaymentStatus.PENDING,
      hasReceipt: false,
    });
  });

  it("no mezcla los pagos de otro cliente", async () => {
    const { db } = setup();
    await pago(db, { loanId: "loan-1", installmentId: "loan-1_1", actor: CLIENTE, key: "k1" });
    const ajeno = await pago(db, { loanId: "loan-2", installmentId: "loan-2_1", actor: OTRO, key: "k2" });

    const lista = await listPaymentsForLoan({ db }, { loanId: "loan-1", userId: "uid-1" });

    expect(ids(lista)).not.toContain(ajeno.paymentId);
    expect(lista).toHaveLength(1);
  });

  it("el préstamo ajeno es 404 y no devuelve pagos de nadie", async () => {
    const { db } = setup();
    await pago(db, { loanId: "loan-2", installmentId: "loan-2_1", actor: OTRO, key: "k1" });

    await expect(listPaymentsForLoan({ db }, { loanId: "loan-2", userId: "uid-1" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("un préstamo sin pagos devuelve una lista vacía, no un error", async () => {
    const { db } = setup();
    await expect(listPaymentsForLoan({ db }, { loanId: "loan-1", userId: "uid-1" })).resolves.toEqual(
      [],
    );
  });

  it("el estado de la cuota refleja la confirmación, no el registro", async () => {
    const { db } = setup();
    const p = await pago(db, { loanId: "loan-1", installmentId: "loan-1_1", actor: CLIENTE, key: "k1" });
    await resolver(db, p.paymentId, "confirm");

    const lista = await listPaymentsForLoan({ db }, { loanId: "loan-1", userId: "uid-1" });

    expect(lista[0]).toMatchObject({
      status: PaymentStatus.CONFIRMED,
      installmentStatus: InstallmentStatus.PAID,
    });
  });
});

describe("listPaymentsForAdmin", () => {
  it("por defecto trae solo los pendientes, de cualquier cliente", async () => {
    const { db } = setup();
    const pendiente1 = await pago(db, { loanId: "loan-1", installmentId: "loan-1_1", actor: CLIENTE, key: "k1" });
    const pendiente2 = await pago(db, { loanId: "loan-2", installmentId: "loan-2_1", actor: OTRO, key: "k2" });
    const confirmado = await pago(db, { loanId: "loan-1", installmentId: "loan-1_2", actor: CLIENTE, key: "k3" });
    await resolver(db, confirmado.paymentId, "confirm");

    const lista = await listPaymentsForAdmin({ db });

    expect(ids(lista).sort()).toEqual([pendiente1.paymentId, pendiente2.paymentId].sort());
  });

  it("filtra por el estado pedido", async () => {
    const { db } = setup();
    const pendiente = await pago(db, { loanId: "loan-1", installmentId: "loan-1_1", actor: CLIENTE, key: "k1" });
    const rechazado = await pago(db, { loanId: "loan-1", installmentId: "loan-1_2", actor: CLIENTE, key: "k2" });
    await resolver(db, rechazado.paymentId, "reject");

    const confirmados = await listPaymentsForAdmin({ db }, { status: PaymentStatus.CONFIRMED });
    const rechazados = await listPaymentsForAdmin({ db }, { status: PaymentStatus.REJECTED });
    const pendientes = await listPaymentsForAdmin({ db }, { status: PaymentStatus.PENDING });

    expect(ids(confirmados)).toEqual([]);
    expect(ids(rechazados)).toEqual([rechazado.paymentId]);
    expect(ids(pendientes)).toEqual([pendiente.paymentId]);
  });

  it("trae lo que el admin necesita para decidir sin leer nada más", async () => {
    const { db } = setup();
    const p = await pago(db, { loanId: "loan-1", installmentId: "loan-1_1", actor: CLIENTE, key: "k1" });

    const [item] = await listPaymentsForAdmin({ db });

    expect(item).toMatchObject({
      paymentId: p.paymentId,
      paymentNumber: p.paymentNumber,
      userId: "uid-1",
      loanId: "loan-1",
      installmentId: "loan-1_1",
      amountPesos: 19_707,
      channel: PaymentChannelType.BANK_TRANSFER,
      reference: "REF-123",
      hasReceipt: false,
      status: PaymentStatus.PENDING,
    });
    expect(item!.createdAt).toBeInstanceOf(Date);
  });

  it("un pago resuelto dice quién lo resolvió y por qué", async () => {
    const { db } = setup();
    const rechazado = await pago(db, { loanId: "loan-1", installmentId: "loan-1_1", actor: CLIENTE, key: "k1" });
    await resolver(db, rechazado.paymentId, "reject");

    const lista = await listPaymentsForAdmin({ db }, { status: PaymentStatus.REJECTED });

    expect(lista[0]).toMatchObject({ resolvedBy: "admin-1", reason: "no llegó el dinero" });
  });

  it("un límite descortona o ignora, nunca deja más de lo pedido", async () => {
    const { db } = setup();
    for (let n = 0; n < 3; n += 1) {
      await pago(db, { loanId: "loan-1", installmentId: "loan-1_1", actor: CLIENTE, key: `k${n}` }).catch(
        () => undefined,
      );
    }

    const dos = await listPaymentsForAdmin({ db }, { limit: 2 });
    const uno = await listPaymentsForAdmin({ db }, { limit: 1 });
    const sinNumero = await listPaymentsForAdmin({ db }, { limit: 0 });

    expect(dos.length).toBeLessThanOrEqual(2);
    expect(uno).toHaveLength(1);
    // Un límite sin sentido no rompe la cola: vuelve al valor por defecto.
    expect(sinNumero.length).toBeGreaterThan(0);
  });

  it("los filtros que ofrece la cola son exactamente los estados que existen", () => {
    expect([...ADMIN_PAYMENT_FILTERS].sort()).toEqual(
      [
        PaymentStatus.PENDING,
        PaymentStatus.CONFIRMED,
        PaymentStatus.REJECTED,
        PaymentStatus.REVERSED,
      ].sort(),
    );
  });

  it("con la cola vacía devuelve una lista vacía", async () => {
    const { db } = setup();
    const lista: AdminPaymentListItem[] = await listPaymentsForAdmin({ db });
    expect(lista).toEqual([]);
  });
});
