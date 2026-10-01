import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPaymentsForAdmin,
  listPaymentsForLoan,
} from "../src/services/payments/payment-list-service";
import { listPublicPaymentChannels } from "../src/services/payments/payment-channel-service";
import { confirmPayment, createPayment, rejectPayment, type PaymentActor } from "../src/services/payments/payment-service";
import { idempotencyKeyId } from "../src/lib/idempotency";
import { buildPaymentChannelDoc, buildPaymentDoc, PaymentChannelType } from "../src/server/payment-doc";
import { buildLoanDoc, buildLoanInstallmentDoc, loanInstallmentDocId } from "../src/server/credit-doc";
import { stripUndefined } from "../src/server/doc";
import {
  Currency,
  InstallmentStatus,
  LoanStatus,
  PaymentStatus,
  Role,
  TermFrequency,
} from "../src/server/types";

/**
 * Lecturas de pagos contra Firestore real (F10-4).
 *
 * Lo que los unitarios no pueden ver y esta suite sí:
 *
 * 1. **Que las consultas no piden índice compuesto.** `deploy:rules` no funciona sin
 *    `roles/datastore.owner`, así que cualquier `where(...) + orderBy(...)` sobre campos distintos
 *    revienta con `FAILED_PRECONDITION` en producción y el mock no lo nota. Aquí las tres
 *    consultas de `payment-list-service` corren contra el proyecto real: si alguien reintroduce un
 *    `orderBy`, esta suite se cae con el mismo error que la app.
 * 2. **Que el ownership se sostiene con los joins que hace el servicio**: `listPaymentsForLoan`
 *    cruza cuotas leídas por el préstamo del titular, no las del doc.
 * 3. **Que la proyección de `meta` a la vista pública funciona con el documento real**, no con un
 *    objeto de test.
 */

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID requerida para tests de integracion. Revisa .env");
}
if (getApps().length === 0) {
  initializeApp({ projectId });
}

const db: Firestore = getFirestore();
const AHORA = new Date("2026-03-24T00:00:00.000Z");
const INSTALLMENT = 13_414;
const INSTALLMENT_COUNT = 2;
const ADMIN: PaymentActor = { uid: `uid-admin-${randomUUID().slice(0, 8)}`, role: Role.ADMIN };

const tracked = {
  loans: new Set<string>(),
  installments: new Set<string>(),
  payments: new Set<string>(),
  channels: new Set<string>(),
  keys: new Set<string>(),
  configs: new Set<string>(),
};

function track(key: keyof typeof tracked, id: string): string {
  tracked[key].add(id);
  return id;
}

function clave(scope: string, key: string): string {
  return track("keys", idempotencyKeyId(scope, key));
}

interface Escenario {
  userId: string;
  loanId: string;
  channelId: string;
  actor: PaymentActor;
}

async function seedEscenario(prefix: string, options: { installmentCount?: number } = {}): Promise<Escenario> {
  const userId = `uid-${prefix}-${randomUUID().slice(0, 8)}`;
  const loanId = track("loans", `loan-${prefix}-${randomUUID().slice(0, 8)}`);
  const channelId = track("channels", `CANAL_${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`);
  const installmentCount = options.installmentCount ?? INSTALLMENT_COUNT;

  await db.collection("loans").doc(loanId).set(
    stripUndefined(
      buildLoanDoc(
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
            termInstallments: installmentCount,
            termFrequency: TermFrequency.BIWEEKLY,
          },
          status: LoanStatus.DISBURSED,
          outstandingPesos: INSTALLMENT * installmentCount,
        },
        AHORA,
      ),
    ),
  );

  for (let n = 1; n <= installmentCount; n += 1) {
    await db
      .collection("loan_installments")
      .doc(track("installments", loanInstallmentDocId(loanId, n)))
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
          name: `Canal de prueba ${prefix}`,
          type: PaymentChannelType.BANK_TRANSFER,
          instructionsText: "Canal ficticio que solo existe para esta prueba de integración.",
          meta: { bankName: "Banco de prueba", notaInterna: "no debe salir al cliente" },
        },
        AHORA,
      ),
    );

  return { userId, loanId, channelId, actor: { uid: userId, role: Role.CUSTOMER } };
}

async function registrarPago(escenario: Escenario, installmentNumber: number, key = randomUUID()) {
  const installmentId = loanInstallmentDocId(escenario.loanId, installmentNumber);
  clave(`payment.create:${installmentId}`, key);
  const pago = await createPayment(
    { db },
    {
      loanId: escenario.loanId,
      installmentId,
      channel: escenario.channelId,
      reference: `REF-${randomUUID().slice(0, 8)}`,
      actor: escenario.actor,
      idempotencyKey: key,
    },
  );
  track("payments", pago.paymentId);
  return pago;
}

async function seedDelinquencyConfig() {
  await db
    .collection("system_config")
    .doc(track("configs", "delinquency"))
    .set({ value: { dueSoonDays: 3, overdueDays: 1, defaultDays: 30 }, updatedBy: ADMIN.uid, updatedAt: AHORA });
}

async function resolver(pago: { paymentId: string }, forma: "confirm" | "reject") {
  const key = randomUUID();
  clave(`payment.${forma}:${pago.paymentId}`, key);
  const input = { paymentId: pago.paymentId, actor: ADMIN, idempotencyKey: key };
  if (forma === "confirm") return confirmPayment({ db }, input);
  return rejectPayment({ db }, { ...input, reason: "la referencia era de otra transferencia" });
}

function ids(items: Array<{ paymentId: string }>): string[] {
  return items.map((item) => item.paymentId);
}

afterEach(async () => {
  await Promise.all(
    [...tracked.payments].map((id) =>
      db
        .collection("audit_logs")
        .where("entityId", "==", id)
        .get()
        .then((snap) => Promise.all(snap.docs.map((doc) => db.collection("audit_logs").doc(doc.id).delete()))),
    ),
  );
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

describe("listPaymentsForLoan contra Firestore real", () => {
  it("devuelve el historial del préstamo con el número y el estado real de su cuota", async () => {
    const escenario = await seedEscenario("a");
    const primero = await registrarPago(escenario, 1);
    const segundo = await registrarPago(escenario, 2);
    await seedDelinquencyConfig();
    await resolver(primero, "confirm");

    const lista = await listPaymentsForLoan({ db }, { loanId: escenario.loanId, userId: escenario.userId });

    expect(ids(lista)).toEqual([segundo.paymentId, primero.paymentId]);
    expect(lista[0]).toMatchObject({
      paymentId: segundo.paymentId,
      installmentId: loanInstallmentDocId(escenario.loanId, 2),
      installmentNumber: 2,
      installmentStatus: InstallmentStatus.PENDING,
      amountPesos: INSTALLMENT,
      status: PaymentStatus.PENDING,
      hasReceipt: false,
    });
    expect(lista[0]?.createdAt).toBeInstanceOf(Date);
    // La cuota quedó pagada al confirmar el primero: el historial lo refleja sin recalcular nada.
    expect(lista[1]).toMatchObject({
      paymentId: primero.paymentId,
      installmentNumber: 1,
      installmentStatus: InstallmentStatus.PAID,
      status: PaymentStatus.CONFIRMED,
    });
  });

  it("marca el comprobante cuando el pago lo tiene, y no lo inventa cuando no", async () => {
    const escenario = await seedEscenario("a");
    const sinComprobante = await registrarPago(escenario, 1);
    // Se escribe a mano porque `buildPaymentDoc` no acepta un estado terminal: el objetivo aquí es
    // la proyección de `receiptUrl`, no la máquina de estados.
    const conComprobanteId = track("payments", `PAY-2026-9${randomUUID().slice(0, 4)}`);
    const installmentId = loanInstallmentDocId(escenario.loanId, 2);
    await db
      .collection("payments")
      .doc(conComprobanteId)
      .set(
        stripUndefined(
          buildPaymentDoc(
            {
              paymentNumber: conComprobanteId,
              userId: escenario.userId,
              loanId: escenario.loanId,
              installmentId,
              amountPesos: INSTALLMENT,
              currency: Currency.COP,
              channel: escenario.channelId,
              idempotencyKey: randomUUID(),
              receiptUrl: "receipts/pagos/prueba-de-integracion.pdf",
            },
            AHORA,
          ),
        ),
      );

    const lista = await listPaymentsForLoan({ db }, { loanId: escenario.loanId, userId: escenario.userId });

    expect(lista.find((item) => item.paymentId === conComprobanteId)?.hasReceipt).toBe(true);
    expect(lista.find((item) => item.paymentId === sinComprobante.paymentId)?.hasReceipt).toBe(false);
  });

  it("no mezcla los pagos de otro cliente y el préstamo ajeno es 404", async () => {
    const propio = await seedEscenario("a");
    const ajeno = await seedEscenario("b");
    await registrarPago(propio, 1);
    const pagoAjeno = await registrarPago(ajeno, 1);

    const lista = await listPaymentsForLoan({ db }, { loanId: propio.loanId, userId: propio.userId });

    expect(ids(lista)).not.toContain(pagoAjeno.paymentId);
    expect(lista).toHaveLength(1);
    await expect(
      listPaymentsForLoan({ db }, { loanId: ajeno.loanId, userId: propio.userId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("omite un pago que apunta a una cuota que no existe, en vez de inventar el número de cuota", async () => {
    const escenario = await seedEscenario("a");
    const bueno = await registrarPago(escenario, 1);
    const huerfanoId = track("payments", `PAY-2026-8${randomUUID().slice(0, 4)}`);
    await db
      .collection("payments")
      .doc(huerfanoId)
      .set(
        stripUndefined(
          buildPaymentDoc(
            {
              paymentNumber: huerfanoId,
              userId: escenario.userId,
              loanId: escenario.loanId,
              // La cuota 99 nunca se generó: corrupción de datos, no un caso normal.
              installmentId: loanInstallmentDocId(escenario.loanId, 99),
              amountPesos: INSTALLMENT,
              currency: Currency.COP,
              channel: escenario.channelId,
              idempotencyKey: randomUUID(),
            },
            AHORA,
          ),
        ),
      );

    const lista = await listPaymentsForLoan({ db }, { loanId: escenario.loanId, userId: escenario.userId });

    expect(ids(lista)).toEqual([bueno.paymentId]);
  });
});

describe("listPaymentsForAdmin contra Firestore real", () => {
  it("sin estado trae solo los PENDING, de cualquier cliente", async () => {
    const a = await seedEscenario("a");
    const b = await seedEscenario("b");
    const pendienteA = await registrarPago(a, 1);
    const pendienteB = await registrarPago(b, 1);
    const resuelto = await registrarPago(a, 2);
    await seedDelinquencyConfig();
    await resolver(resuelto, "confirm");

    const cola = await listPaymentsForAdmin({ db });

    expect(ids(cola).sort()).toEqual([pendienteA.paymentId, pendienteB.paymentId].sort());
  });

  it("filtra por el estado pedido y dice quién resolvió el pago", async () => {
    const escenario = await seedEscenario("a");
    const confirmado = await registrarPago(escenario, 1);
    const rechazado = await registrarPago(escenario, 2);
    await seedDelinquencyConfig();
    await resolver(confirmado, "confirm");
    await resolver(rechazado, "reject");

    const confirmados = await listPaymentsForAdmin({ db }, { status: PaymentStatus.CONFIRMED });
    const rechazados = await listPaymentsForAdmin({ db }, { status: PaymentStatus.REJECTED });

    expect(ids(confirmados)).toEqual([confirmado.paymentId]);
    expect(ids(rechazados)).toEqual([rechazado.paymentId]);
    expect(confirmados[0]?.resolvedBy).toBe(ADMIN.uid);
    expect(rechazados[0]).toMatchObject({ resolvedBy: ADMIN.uid, reason: "la referencia era de otra transferencia" });
  });

  it("el límite recorta lo que el admin pidió", async () => {
    const escenario = await seedEscenario("a");
    await registrarPago(escenario, 1);
    await registrarPago(escenario, 2);

    expect(await listPaymentsForAdmin({ db }, { limit: 1 })).toHaveLength(1);
    expect(await listPaymentsForAdmin({ db }, { limit: 2 })).toHaveLength(2);
    // Sin sentido no es un error: vuelve al tope por defecto.
    expect(await listPaymentsForAdmin({ db }, { limit: 0 })).toHaveLength(2);
  });
});

describe("listPublicPaymentChannels contra Firestore real", () => {
  it("solo trae los canales activos y recorta meta a la allowlist pública", async () => {
    const escenario = await seedEscenario("a");
    const inactivoId = track("channels", `CANAL_INACTIVO_${randomUUID().slice(0, 8).toUpperCase()}`);
    await db
      .collection("payment_channels")
      .doc(inactivoId)
      .set(
        buildPaymentChannelDoc(
          {
            name: "Canal cerrado por el admin",
            type: PaymentChannelType.NEQUI,
            instructionsText: "Este canal ya no debe aparecerle al cliente.",
            isActive: false,
          },
          AHORA,
        ),
      );

    const canales = await listPublicPaymentChannels({ db });

    const propio = canales.find((canal) => canal.id === escenario.channelId);
    expect(propio).toBeDefined();
    // La cuenta a la que hay que transferir sí sale: sin ella el cliente no puede pagar.
    expect(propio?.meta.bankName).toBe("Banco de prueba");
    // Y lo que un admin escribió para sí, no.
    expect(propio?.meta).not.toHaveProperty("notaInterna");
    expect(Object.keys(propio?.meta ?? {})).toEqual(["bankName"]);
    expect(canales.some((canal) => canal.id === inactivoId)).toBe(false);
  });
});
