import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it } from "vitest";
import {
  confirmPayment,
  createPayment,
  getPaymentForUser,
  rejectPayment,
  reversePayment,
} from "../src/services/payments/payment-service";
import { idempotencyKeyId } from "../src/lib/idempotency";
import { buildPaymentChannelDoc, paymentDocSchema, PaymentChannelType } from "../src/server/payment-doc";
import { buildLoanDoc, buildLoanInstallmentDoc, loanInstallmentDocId } from "../src/server/credit-doc";
import { stripUndefined } from "../src/server/doc";
import {
  AuditAction,
  DelinquencyStatus,
  InstallmentStatus,
  LoanStatus,
  PaymentStatus,
  Role,
  TermFrequency,
} from "../src/server/types";
import type { Firestore } from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID requerida para tests de integracion. Revisa .env");
}
if (getApps().length === 0) {
  initializeApp({ projectId });
}

const db: Firestore = getFirestore();
const AHORA = new Date("2026-03-24T00:00:00.000Z");

/**
 * Todo lo que el test escribe se anota aquí y se borra en el `afterEach`. Los pagos usan el
 * `paymentNumber` como doc ID, así que un test que se cae a mitad le deja docs con nombres que
 * parecen de producción: exactamente la fuga que `check-test-leftovers` no vería.
 */
const tracked = {
  loans: new Set<string>(),
  installments: new Set<string>(),
  payments: new Set<string>(),
  channels: new Set<string>(),
  keys: new Set<string>(),
  audits: new Set<string>(),
  configs: new Set<string>(),
};

function track(key: keyof typeof tracked, id: string): string {
  tracked[key].add(id);
  return id;
}

/** La clave de idempotencia que usa el test, para borrarla junto con lo demás. */
function clave(scope: string, key: string): string {
  return track("keys", idempotencyKeyId(scope, key));
}

const INSTALLMENT = 13_414;
const INSTALLMENT_COUNT = 2;

async function seedScenario(options: { userId?: string; loanStatus?: LoanStatus } = {}) {
  const userId = options.userId ?? `uid-pay-${randomUUID().slice(0, 8)}`;
  const loanId = track("loans", `loan-pay-${randomUUID().slice(0, 8)}`);
  const channelId = track(
    "channels",
    `CANAL_TEST_${randomUUID().slice(0, 8).toUpperCase()}`,
  );

  const loan = buildLoanDoc(
    {
      loanNumber: `LOAN-${loanId.toUpperCase()}`,
      applicationId: `APP-${loanId.toUpperCase()}`,
      userId,
      productCode: "MICRO_BASICO",
      principalPesos: 20_000,
      interestPesos: 2_000,
      feePesos: 1_000,
      pricing: {
        annualRateBps: 2_400,
        effectiveFeeBps: 500,
        rateVersion: 1,
        termInstallments: INSTALLMENT_COUNT,
        termFrequency: TermFrequency.BIWEEKLY,
      },
      status: options.loanStatus ?? LoanStatus.DISBURSED,
      outstandingPesos: 23_000,
    },
    AHORA,
  );
  // Los builders dejan los opcionales en `undefined` y Firestore los rechaza: todo doc que se
  // escribe pasa por `stripUndefined`, igual que en los servicios.
  await db.collection("loans").doc(loanId).set(stripUndefined(loan));

  for (let n = 1; n <= INSTALLMENT_COUNT; n += 1) {
    const installmentId = track("installments", loanInstallmentDocId(loanId, n));
    await db
      .collection("loan_installments")
      .doc(installmentId)
      .set(
        stripUndefined(
          buildLoanInstallmentDoc({
            loanId,
            installmentNumber: n,
            dueDate: AHORA,
            principalPesos: 10_000,
            interestPesos: 2_000,
            feePesos: 1_414,
          }),
        ),
      );
  }

  await db
    .collection("payment_channels")
    .doc(channelId)
    .set(
      buildPaymentChannelDoc(
        {
          name: "Canal de prueba",
          type: PaymentChannelType.BANK_TRANSFER,
          instructionsText: "Canal ficticio que solo existe para esta prueba de integración.",
          meta: { test: true },
        },
        AHORA,
      ),
    );

  const actor = { uid: userId, role: Role.CUSTOMER };
  const installmentId = loanInstallmentDocId(loanId, 1);
  return { userId, loanId, installmentId, channelId, actor };
}

function input(escenario: Awaited<ReturnType<typeof seedScenario>>, idempotencyKey: string) {
  clave(`payment.create:${escenario.installmentId}`, idempotencyKey);
  return {
    loanId: escenario.loanId,
    installmentId: escenario.installmentId,
    channel: escenario.channelId,
    idempotencyKey,
    actor: escenario.actor,
  };
}

function secuenciaDe(paymentNumber: string): number {
  return Number.parseInt(paymentNumber.split("-")[2] ?? "0", 10);
}

afterEach(async () => {
  // Los `audit_logs` se crean con id automático: se localizan por el `entityId` del pago.
  await Promise.all(
    [...tracked.payments].map((id) =>
      db
        .collection("audit_logs")
        .where("entityId", "==", id)
        .get()
        .then((snap) => Promise.all(snap.docs.map((doc) => db.collection("audit_logs").doc(doc.id).delete()))),
    ),
  );
  // `payment_events` usa id determinista `${paymentId}_${n}` (F10-2b).
  await Promise.all(
    [...tracked.payments].flatMap((id) =>
      [1, 2].map((n) => db.collection("payment_events").doc(`${id}_${n}`).delete()),
    ),
  );
  await Promise.all([
    ...[...tracked.payments].map((id) => db.collection("payments").doc(id).delete()),
    ...[...tracked.installments].map((id) => db.collection("loan_installments").doc(id).delete()),
    ...[...tracked.loans].map((id) => db.collection("loans").doc(id).delete()),
    ...[...tracked.channels].map((id) => db.collection("payment_channels").doc(id).delete()),
    ...[...tracked.keys].map((id) => db.collection("idempotency_keys").doc(id).delete()),
    ...[...tracked.configs].map((id) => db.collection("system_config").doc(id).delete()),
  ]);
  for (const set of Object.values(tracked)) set.clear();
});

describe("createPayment contra Firestore real", () => {
  it("registra el pago PENDING con el saldo de la cuota, sin pagar nada todavía", async () => {
    const escenario = await seedScenario();

    const result = await createPayment({ db }, input(escenario, randomUUID()));
    track("payments", result.paymentId);

    expect(result.status).toBe(PaymentStatus.PENDING);
    expect(result.amountPesos).toBe(INSTALLMENT);
    expect(result.replayed).toBe(false);
    expect(result.paymentNumber).toMatch(new RegExp(`^PAY-${new Date().getFullYear()}-\\d{4}$`));
    expect(result.installmentStatus).toBe(InstallmentStatus.PENDING);

    // El doc real tiene que parsear contra el schema, no solo "verse bien".
    const snap = await db.collection("payments").doc(result.paymentId).get();
    const parsed = paymentDocSchema.parse(snap.data());
    expect(parsed.amountPesos).toBe(INSTALLMENT);
    expect(parsed.userId).toBe(escenario.userId);
    expect(parsed.confirmedBy).toBeUndefined();

    // Candado puesto, cuota y préstamo sin tocar.
    const cuota = await db.collection("loan_installments").doc(escenario.installmentId).get();
    expect(cuota.data()?.pendingPaymentId).toBe(result.paymentId);
    expect(cuota.data()?.paidPesos).toBe(0);
    expect(cuota.data()?.status).toBe(InstallmentStatus.PENDING);
    const loan = await db.collection("loans").doc(escenario.loanId).get();
    expect(loan.data()?.outstandingPesos).toBe(23_000);
    expect(loan.data()?.status).toBe(LoanStatus.DISBURSED);

    const audit = await db
      .collection("audit_logs")
      .where("entityId", "==", result.paymentId)
      .get();
    expect(audit.docs).toHaveLength(1);
    expect(audit.docs[0]?.data()).toMatchObject({
      action: "PAYMENT_CREATED",
      entityType: "payment",
      entityId: result.paymentId,
    });
  });

  it("el importe lo decide el servidor aunque el request traiga amountPesos", async () => {
    const escenario = await seedScenario();
    const manipulado = { ...input(escenario, randomUUID()), amountPesos: 1 } as Parameters<
      typeof createPayment
    >[1];

    const result = await createPayment({ db }, manipulado);
    track("payments", result.paymentId);

    expect(result.amountPesos).toBe(INSTALLMENT);
  });

  it("la misma clave dos veces devuelve el mismo pago y no duplica ni pagos ni auditoría", async () => {
    const escenario = await seedScenario();
    const key = randomUUID();

    const primero = await createPayment({ db }, input(escenario, key));
    track("payments", primero.paymentId);
    const segundo = await createPayment({ db }, input(escenario, key));

    expect(segundo.replayed).toBe(true);
    expect(segundo.paymentId).toBe(primero.paymentId);

    const delPrestamo = await db
      .collection("payments")
      .where("loanId", "==", escenario.loanId)
      .get();
    expect(delPrestamo.docs).toHaveLength(1);
    const audit = await db.collection("audit_logs").where("entityId", "==", primero.paymentId).get();
    expect(audit.docs).toHaveLength(1);
  });

  /**
   * La razón de existir de `pendingPaymentId`. Dos registros simultáneos de la misma cuota con
   * claves distintas: los dos False. Sin el candado, los dos habrían creado su pago PENDING y el
   * admin tendría que rechazar uno a mano. Aquí gana uno y el otro recibe 409.
   */
  it("dos registros simultáneos de la misma cuota: solo uno gana", async () => {
    const escenario = await seedScenario();

    const resultados = await Promise.allSettled([
      createPayment({ db }, input(escenario, randomUUID())),
      createPayment({ db }, input(escenario, randomUUID())),
    ]);

    const exitosos = resultados.filter((r) => r.status === "fulfilled");
    const fallidos = resultados.filter((r) => r.status === "rejected");
    for (const exito of exitosos) {
      track("payments", (exito as PromiseFulfilledResult<{ paymentId: string }>).value.paymentId);
    }

    expect(exitosos).toHaveLength(1);
    expect(fallidos).toHaveLength(1);
    expect((fallidos[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });

    const delPrestamo = await db.collection("payments").where("loanId", "==", escenario.loanId).get();
    expect(delPrestamo.docs).toHaveLength(1);
  });

  it("numera consecutivo dentro del año", async () => {
    const escenario = await seedScenario();
    const segundaCuota = loanInstallmentDocId(escenario.loanId, 2);
    clave(`payment.create:${segundaCuota}`, randomUUID());

    const primero = await createPayment({ db }, input(escenario, randomUUID()));
    track("payments", primero.paymentId);
    const segundo = await createPayment(
      { db },
      {
        loanId: escenario.loanId,
        installmentId: segundaCuota,
        channel: escenario.channelId,
        idempotencyKey: randomUUID(),
        actor: escenario.actor,
      },
    );
    track("payments", segundo.paymentId);

    expect(secuenciaDe(segundo.paymentNumber)).toBe(secuenciaDe(primero.paymentNumber) + 1);
  });

  it("un pago de otro cliente responde 404, igual que uno inexistente", async () => {
    const escenario = await seedScenario();
    const creado = await createPayment({ db }, input(escenario, randomUUID()));
    track("payments", creado.paymentId);

    const ajeno = `uid-otro-${randomUUID().slice(0, 8)}`;
    await expect(
      getPaymentForUser({ db }, { paymentId: creado.paymentId, userId: ajeno }),
    ).rejects.toMatchObject({ statusCode: 404, message: "Pago no encontrado" });
    await expect(
      getPaymentForUser({ db }, { paymentId: `PAY-1999-0001`, userId: ajeno }),
    ).rejects.toMatchObject({ statusCode: 404, message: "Pago no encontrado" });
  });

  it("no deja pagar un préstamo ajeno ni uno que no ha sido desembolsado", async () => {
    const propio = await seedScenario();
    const ajeno = await seedScenario({ userId: `uid-otro-${randomUUID().slice(0, 8)}` });

    await expect(
      createPayment({ db }, { ...input(ajeno, randomUUID()), loanId: propio.loanId }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const pendiente = await seedScenario({ loanStatus: LoanStatus.PENDING_DISBURSEMENT });
    await expect(createPayment({ db }, input(pendiente, randomUUID()))).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

/** ==================== Resolución ADMIN contra Firestore real (F10-2b) ==================== */

const ADMIN = { uid: `uid-admin-${randomUUID().slice(0, 8)}`, role: Role.ADMIN };

async function seedDelinquencyConfig() {
  const id = track("configs", "delinquency");
  await db.collection("system_config").doc(id).set({
    value: { dueSoonDays: 3, overdueDays: 1, defaultDays: 30 },
    updatedBy: ADMIN.uid,
    updatedAt: AHORA,
  });
}

/** Marca la clave de idempotencia de una operación admin y su pago para el cleanup. */
function adminClave(action: "confirm" | "reject" | "reverse", paymentId: string, key: string): string {
  return clave(`payment.${action}:${paymentId}`, key);
}

describe("confirmPayment contra Firestore real", () => {
  it("confirma, salda la cuota y recalcula saldo y mora del préstamo", async () => {
    const escenario = await seedScenario();
    const pago = await createPayment({ db }, input(escenario, randomUUID()));
    track("payments", pago.paymentId);
    await seedDelinquencyConfig();
    const key = adminClave("confirm", pago.paymentId, randomUUID());

    const resultado = await confirmPayment({ db }, { paymentId: pago.paymentId, actor: ADMIN, idempotencyKey: key });

    expect(resultado.status).toBe(PaymentStatus.CONFIRMED);
    expect(resultado.replayed).toBe(false);
    // Solo queda la cuota 2 (13.414): el recálculo sale de las cuotas, no del caché del préstamo.
    expect(resultado.loan.outstandingPesos).toBe(INSTALLMENT);
    expect(resultado.loan.status).toBe(LoanStatus.DISBURSED);

    const cuota = await db.collection("loan_installments").doc(pago.installmentId).get();
    expect(cuota.data()).toMatchObject({
      status: InstallmentStatus.PAID,
      paidPesos: INSTALLMENT,
      paymentId: pago.paymentId,
    });
    expect(cuota.data()?.pendingPaymentId).toBeUndefined();
    expect(cuota.data()?.paidAt).toBeDefined();

    const loan = await db.collection("loans").doc(escenario.loanId).get();
    expect(loan.data()?.outstandingPesos).toBe(INSTALLMENT);
    expect(loan.data()?.delinquencyStatus).toBeDefined();

    const evento = await db.collection("payment_events").doc(`${pago.paymentId}_1`).get();
    expect(evento.exists).toBe(true);
    expect(evento.data()).toMatchObject({ fromStatus: PaymentStatus.PENDING, toStatus: PaymentStatus.CONFIRMED });
    const audit = await db.collection("audit_logs").where("entityId", "==", pago.paymentId).get();
    expect(audit.docs.some((doc) => doc.data().action === AuditAction.PAYMENT_CONFIRMED)).toBe(true);
  });

  it("el último pago salda el préstamo: status PAID y paidAt", async () => {
    const escenario = await seedScenario();
    await seedDelinquencyConfig();
    const segundoId = loanInstallmentDocId(escenario.loanId, 2);
    clave(`payment.create:${segundoId}`, randomUUID());

    const p1 = await createPayment({ db }, input(escenario, randomUUID()));
    track("payments", p1.paymentId);
    const p2 = await createPayment(
      { db },
      {
        loanId: escenario.loanId,
        installmentId: segundoId,
        channel: escenario.channelId,
        idempotencyKey: randomUUID(),
        actor: escenario.actor,
      },
    );
    track("payments", p2.paymentId);

    await confirmPayment(
      { db },
      { paymentId: p1.paymentId, actor: ADMIN, idempotencyKey: adminClave("confirm", p1.paymentId, randomUUID()) },
    );
    const resultado = await confirmPayment(
      { db },
      { paymentId: p2.paymentId, actor: ADMIN, idempotencyKey: adminClave("confirm", p2.paymentId, randomUUID()) },
    );

    expect(resultado.loan.outstandingPesos).toBe(0);
    expect(resultado.loan.delinquencyStatus).toBe(DelinquencyStatus.PAID);
    expect(resultado.loan.status).toBe(LoanStatus.PAID);
    const loan = await db.collection("loans").doc(escenario.loanId).get();
    expect(loan.data()?.paidAt).toBeDefined();
  });
});

describe("rejectPayment contra Firestore real", () => {
  it("rechaza, suelta el candado y deja la cuota libre para un pago nuevo", async () => {
    const escenario = await seedScenario();
    const primero = await createPayment({ db }, input(escenario, randomUUID()));
    track("payments", primero.paymentId);

    const resultado = await rejectPayment(
      { db },
      {
        paymentId: primero.paymentId,
        actor: ADMIN,
        idempotencyKey: adminClave("reject", primero.paymentId, randomUUID()),
        reason: "La referencia 100 realmente fue de otra transferencia",
      },
    );

    expect(resultado.status).toBe(PaymentStatus.REJECTED);
    const cuota = await db.collection("loan_installments").doc(escenario.installmentId).get();
    expect(cuota.data()?.pendingPaymentId).toBeUndefined();
    expect(cuota.data()?.status).toBe(InstallmentStatus.PENDING);

    const segundo = await createPayment({ db }, input(escenario, randomUUID()));
    track("payments", segundo.paymentId);
    expect(segundo.paymentId).not.toBe(primero.paymentId);
    expect(segundo.status).toBe(PaymentStatus.PENDING);
  });

  it("no rechaza un pago ya confirmado", async () => {
    const escenario = await seedScenario();
    const pago = await createPayment({ db }, input(escenario, randomUUID()));
    track("payments", pago.paymentId);
    await seedDelinquencyConfig();
    await confirmPayment(
      { db },
      { paymentId: pago.paymentId, actor: ADMIN, idempotencyKey: adminClave("confirm", pago.paymentId, randomUUID()) },
    );

    await expect(
      rejectPayment(
        { db },
        {
          paymentId: pago.paymentId,
          actor: ADMIN,
          idempotencyKey: adminClave("reject", pago.paymentId, randomUUID()),
          reason: "Llegó tarde",
        },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("reversePayment contra Firestore real", () => {
  it("revierte un pago confirmado y devuelve la cuota a PENDING", async () => {
    const escenario = await seedScenario();
    await seedDelinquencyConfig();
    const pago = await createPayment({ db }, input(escenario, randomUUID()));
    track("payments", pago.paymentId);
    await confirmPayment(
      { db },
      { paymentId: pago.paymentId, actor: ADMIN, idempotencyKey: adminClave("confirm", pago.paymentId, randomUUID()) },
    );

    const resultado = await reversePayment(
      { db },
      {
        paymentId: pago.paymentId,
        actor: ADMIN,
        idempotencyKey: adminClave("reverse", pago.paymentId, randomUUID()),
        reason: "La transferencia fue devuelta por el banco",
      },
    );

    expect(resultado.status).toBe(PaymentStatus.REVERSED);
    // Vuelve a haber 2 cuotas impagas.
    expect(resultado.loan.outstandingPesos).toBe(INSTALLMENT * 2);

    const cuota = await db.collection("loan_installments").doc(pago.installmentId).get();
    expect(cuota.data()).toMatchObject({ status: InstallmentStatus.PENDING, paidPesos: 0 });
    expect(cuota.data()?.paymentId).toBeUndefined();
    expect(cuota.data()?.paidAt).toBeUndefined();

    const evento = await db.collection("payment_events").doc(`${pago.paymentId}_2`).get();
    expect(evento.exists).toBe(true);
    expect(evento.data()).toMatchObject({ fromStatus: PaymentStatus.CONFIRMED, toStatus: PaymentStatus.REVERSED });
  });
});
