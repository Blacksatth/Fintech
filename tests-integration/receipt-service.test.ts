import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it } from "vitest";
import { attachPaymentReceipt, getPaymentReceiptUrl } from "../src/services/payments/receipt-service";
import { confirmPayment, createPayment } from "../src/services/payments/payment-service";
import { idempotencyKeyId } from "../src/lib/idempotency";
import { buildPaymentChannelDoc, paymentDocSchema, PaymentChannelType } from "../src/server/payment-doc";
import { buildLoanDoc, buildLoanInstallmentDoc, loanInstallmentDocId } from "../src/server/credit-doc";
import { stripUndefined } from "../src/server/doc";
import { parseReceiptReference, type ReceiptStore } from "../src/server/receipt";
import {
  AuditAction,
  InstallmentStatus,
  LoanStatus,
  PaymentStatus,
  Role,
  TermFrequency,
} from "../src/server/types";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Comprobantes contra **Firestore real**, con el almacenamiento doblado.
 *
 * Aquí no se prueba Cloudinary (eso es `npm run smoke:cloudinary`, que sí necesita credenciales):
 * se prueba lo que el mock de Firestore no puede saber, que es que la transacción que escribe
 * `receiptUrl` + auditoría es legal en el Firestore de verdad (un `get` después de un `update`
 * aborta la transacción) y que el documento resultante sigue.parseando contra el schema.
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x2a, 0x2a]);
const INSTALLMENT_COUNT = 2;

/** Almacenamiento doblado: no hay red, pero deja constancia de lo que se le pidió. */
class FakeReceiptStore implements ReceiptStore {
  readonly uploads: string[] = [];
  readonly destroyed: string[] = [];

  async upload(input: { publicId: string }) {
    this.uploads.push(input.publicId);
    return { publicId: input.publicId, format: "png" };
  }

  signedDeliveryUrl(reference: { publicId: string; format: string }, ttlSeconds: number): string {
    return `https://firma.invalida/${reference.publicId}.${reference.format}?ttl=${ttlSeconds}`;
  }

  async destroy(reference: { publicId: string }): Promise<void> {
    this.destroyed.push(reference.publicId);
  }
}

const tracked = {
  loans: new Set<string>(),
  installments: new Set<string>(),
  payments: new Set<string>(),
  channels: new Set<string>(),
  keys: new Set<string>(),
};

function track(key: keyof typeof tracked, id: string): string {
  tracked[key].add(id);
  return id;
}

async function seedScenario(options: { userId?: string } = {}) {
  const userId = options.userId ?? `uid-rec-${randomUUID().slice(0, 8)}`;
  const loanId = track("loans", `loan-rec-${randomUUID().slice(0, 8)}`);
  const channelId = track("channels", `CANAL_REC_${randomUUID().slice(0, 8).toUpperCase()}`);

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
      status: LoanStatus.DISBURSED,
      outstandingPesos: 23_000,
    },
    AHORA,
  );
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
          instructionsText: "Canal ficticio para la prueba de integración del comprobante.",
          meta: { test: true },
        },
        AHORA,
      ),
    );

  const installmentId = loanInstallmentDocId(loanId, 1);
  const idempotencyKey = randomUUID();
  track("keys", idempotencyKeyId(`payment.create:${installmentId}`, idempotencyKey));

  const pago = await createPayment(
    { db },
    {
      loanId,
      installmentId,
      channel: channelId,
      actor: { uid: userId, role: Role.CUSTOMER },
      idempotencyKey,
    },
  );
  track("payments", pago.paymentId);

  const actor = { uid: userId, role: Role.CUSTOMER };
  return { userId, loanId, installmentId, channelId, pago, actor };
}

function archivo(over: Partial<{ filename: string; declaredType: string; bytes: Uint8Array }> = {}) {
  return { filename: "comprobante.png", declaredType: "image/png", bytes: PNG, ...over };
}

afterEach(async () => {
  await Promise.all(
    [...tracked.payments].map((id) =>
      db
        .collection("audit_logs")
        .where("entityId", "==", id)
        .get()
        .then((snap) =>
          Promise.all(snap.docs.map((doc) => db.collection("audit_logs").doc(doc.id).delete())),
        ),
    ),
  );
  // `payment_events` usa id determinista `${paymentId}_${n}` y **no** se borra con el pago. Sin
  // esta línea, un evento huérfano hace que otro test que recalcula el consecutivo del año elija
  // un número ya usado y choque con "la transición ya se registró": los archivos de integración
  // corren en paralelo contra el mismo proyecto.
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
  ]);
  for (const set of Object.values(tracked)) set.clear();
});

describe("comprobante contra Firestore real", () => {
  it("escribe receiptUrl y la auditoría en una transacción legal", async () => {
    // Si la transacción leyera después de escribir, Firestore real la abortaría con
    // FAILED_PRECONDITION y este test fallaría: es justo lo que el mock no detecta.
    const escenario = await seedScenario();
    const receipts = new FakeReceiptStore();

    const resultado = await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: escenario.pago.paymentId, actor: escenario.actor, file: archivo() },
    );

    expect(resultado.hasReceipt).toBe(true);
    expect(receipts.uploads).toHaveLength(1);

    const snap = await db.collection("payments").doc(escenario.pago.paymentId).get();
    // El doc real tiene que seguir parseando contra el schema después de la escritura.
    const parsed = paymentDocSchema.parse(snap.data());
    expect(parsed.status).toBe(PaymentStatus.PENDING);
    expect(parsed.receiptUrl).toBeDefined();

    const reference = parseReceiptReference(parsed.receiptUrl!, escenario.pago.paymentNumber);
    expect(reference).not.toBeNull();
    expect(reference!.format).toBe("png");

    const audit = await db
      .collection("audit_logs")
      .where("entityId", "==", escenario.pago.paymentId)
      .where("action", "==", AuditAction.PAYMENT_RECEIPT_UPLOADED)
      .get();
    expect(audit.docs).toHaveLength(1);
    expect(audit.docs[0]?.data()).toMatchObject({
      action: AuditAction.PAYMENT_RECEIPT_UPLOADED,
      entityType: "payment",
      entityId: escenario.pago.paymentId,
    });
  });

  it("no toca cuota ni préstamo: el pago sigue pendiente de confirmación humana", async () => {
    const escenario = await seedScenario();
    const receipts = new FakeReceiptStore();

    await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: escenario.pago.paymentId, actor: escenario.actor, file: archivo() },
    );

    const cuota = await db.collection("loan_installments").doc(escenario.installmentId).get();
    expect(cuota.data()?.status).toBe(InstallmentStatus.PENDING);
    expect(cuota.data()?.paidPesos).toBe(0);
    const loan = await db.collection("loans").doc(escenario.loanId).get();
    expect(loan.data()?.outstandingPesos).toBe(23_000);
    expect(loan.data()?.status).toBe(LoanStatus.DISBURSED);
  });

  it("el comprobante se puede volver a subir y el anterior se borra del almacenamiento", async () => {
    const escenario = await seedScenario();
    const receipts = new FakeReceiptStore();

    await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: escenario.pago.paymentId, actor: escenario.actor, file: archivo() },
    );
    const antes = (await db.collection("payments").doc(escenario.pago.paymentId).get()).data()
      ?.receiptUrl as string;

    const segundo = await attachPaymentReceipt(
      { db, store: receipts },
      {
        paymentId: escenario.pago.paymentId,
        actor: escenario.actor,
        file: archivo({ filename: "corregido.png" }),
      },
    );

    expect(segundo.replacedPrevious).toBe(true);
    const despues = (await db.collection("payments").doc(escenario.pago.paymentId).get()).data()
      ?.receiptUrl as string;
    expect(despues).not.toBe(antes);
    expect(receipts.destroyed).toHaveLength(1);
    expect(receipts.destroyed[0]).toBe(receipts.uploads[0]);
  });

  it("un pago ajeno es 404 y no sube nada", async () => {
    const escenario = await seedScenario();
    const receipts = new FakeReceiptStore();
    const intruso = `uid-intruso-${randomUUID().slice(0, 8)}`;

    await expect(
      attachPaymentReceipt(
        { db, store: receipts },
        {
          paymentId: escenario.pago.paymentId,
          actor: { uid: intruso, role: Role.CUSTOMER },
          file: archivo(),
        },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(receipts.uploads).toHaveLength(0);
    const snap = await db.collection("payments").doc(escenario.pago.paymentId).get();
    expect(snap.data()?.receiptUrl).toBeUndefined();
  });

  it("un pago confirmado ya no admite comprobante", async () => {
    const escenario = await seedScenario();
    const receipts = new FakeReceiptStore();
    const key = randomUUID();
    track("keys", idempotencyKeyId(`payment.confirm:${escenario.pago.paymentId}`, key));
    await confirmPayment(
      { db },
      {
        paymentId: escenario.pago.paymentId,
        actor: { uid: "admin-test", role: Role.ADMIN },
        idempotencyKey: key,
      },
    );

    await expect(
      attachPaymentReceipt(
        { db, store: receipts },
        { paymentId: escenario.pago.paymentId, actor: escenario.actor, file: archivo() },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(receipts.uploads).toHaveLength(0);
  });

  it("firma el comprobante del pago confirmado para el admin que lo resolvió", async () => {
    const escenario = await seedScenario();
    const receipts = new FakeReceiptStore();
    await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: escenario.pago.paymentId, actor: escenario.actor, file: archivo() },
    );
    const key = randomUUID();
    track("keys", idempotencyKeyId(`payment.confirm:${escenario.pago.paymentId}`, key));
    await confirmPayment(
      { db },
      {
        paymentId: escenario.pago.paymentId,
        actor: { uid: "admin-test", role: Role.ADMIN },
        idempotencyKey: key,
      },
    );

    const vista = await getPaymentReceiptUrl(
      { db, store: receipts },
      { paymentId: escenario.pago.paymentId, actor: { uid: "admin-test", role: Role.ADMIN } },
    );

    expect(vista.url).toContain("microcredito/payments");
    expect(vista.url).toContain("ttl=300");
    expect(new Date(vista.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
