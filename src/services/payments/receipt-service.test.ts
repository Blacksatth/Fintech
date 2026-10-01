import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createFirestoreMock } from "@/test-utils/firestore-mock";
import {
  AuditAction,
  DelinquencyStatus,
  InstallmentStatus,
  LoanStatus,
  PaymentStatus,
  Role,
} from "@/server/types";
import { PaymentChannelType } from "@/server/payment-doc";
import {
  ReceiptStorageError,
  buildReceiptReference,
  type ReceiptReference,
  type ReceiptStore,
} from "@/server/receipt";
import { AppError } from "@/lib/errors";
import { confirmPayment, createPayment, type PaymentActor } from "./payment-service";
import { attachPaymentReceipt, getPaymentReceiptUrl } from "./receipt-service";

/**
 * Un comprobante **no paga**: estas pruebas comprueban sobre todo que su cabecera no mueva ni el
 * pago, ni la cuota, ni el préstamo, y que lo que queda en Firestore sea solo la referencia.
 */

const CLIENTE: PaymentActor = { uid: "uid-1", role: Role.CUSTOMER };
const OTRO_CLIENTE: PaymentActor = { uid: "uid-2", role: Role.CUSTOMER };
const ADMIN: PaymentActor = { uid: "admin-1", role: Role.ADMIN };
const AHORA = new Date("2026-03-24T00:00:00.000Z");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);

/** Snapshot de pricing del préstamo: sin él, confirmar no puede recalcular el saldo. */
const PRICING = {
  annualRateBps: 5_800,
  effectiveFeeBps: 0,
  rateVersion: 1,
  termInstallments: 3,
  termFrequency: "WEEKLY",
};

/** Doble de almacenamiento: registra lo que se le pidió y deja fallar cada operación. */
class FakeReceiptStore implements ReceiptStore {
  readonly uploads: Array<{ publicId: string; bytes: Uint8Array; contentType: string }> = [];
  readonly destroyed: ReceiptReference[] = [];
  readonly signed: Array<{ reference: ReceiptReference; ttlSeconds: number }> = [];
  failUpload: Error | null = null;
  failSign: Error | null = null;
  /** Simula lo que pasa en el mundo real mientras se sube: otro actor actúa. */
  onUpload: (() => Promise<void>) | null = null;

  async upload(input: { publicId: string; bytes: Uint8Array; contentType: string }) {
    this.uploads.push({ ...input, bytes: input.bytes.slice() });
    await this.onUpload?.();
    if (this.failUpload) throw this.failUpload;
    return { publicId: input.publicId, format: "png" };
  }

  signedDeliveryUrl(reference: ReceiptReference, ttlSeconds: number): string {
    if (this.failSign) throw this.failSign;
    this.signed.push({ reference, ttlSeconds });
    return `https://firma.invalida/${reference.publicId}.${reference.format}?exp=${ttlSeconds}`;
  }

  async destroy(reference: ReceiptReference): Promise<void> {
    this.destroyed.push(reference);
  }
}

function setup() {
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
  store.seed("loan_installments", "loan-1_1", installment(1));
  store.seed("loan_installments", "loan-1_2", installment(2));
  store.seed("loan_installments", "loan-1_3", installment(3));
  store.seed("loans", "loan-2", {
    loanNumber: "LOAN-0002",
    applicationId: "APP-2",
    userId: "uid-2",
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
  store.seed("loan_installments", "loan-2_1", installment(1, "loan-2"));
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

  return { db: db as Firestore, store, receipts: new FakeReceiptStore() };
}

function installment(installmentNumber: number, loanId = "loan-1") {
  return {
    loanId,
    installmentNumber,
    dueDate: AHORA,
    principalPesos: 10_000,
    interestPesos: 2_000,
    feePesos: 1_414,
    totalPesos: 13_414,
    paidPesos: 0,
    status: InstallmentStatus.PENDING,
  };
}

async function pagoPendiente(db: Firestore, loanId = "loan-1", installmentId = "loan-1_1") {
  return createPayment(
    { db },
    {
      loanId,
      installmentId,
      channel: PaymentChannelType.BANK_TRANSFER,
      actor: loanId === "loan-1" ? CLIENTE : OTRO_CLIENTE,
      idempotencyKey: `k-${installmentId}`,
    },
  );
}

function archivo(over: Partial<{ filename: string; declaredType: string; bytes: Uint8Array }> = {}) {
  return { filename: "comprobante.png", declaredType: "image/png", bytes: PNG, ...over };
}

function audits(store: ReturnType<typeof createFirestoreMock>["store"], action: string) {
  return store.list("audit_logs").filter((row) => row["action"] === action);
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toMatchObject({ statusCode: status });
}

describe("attachPaymentReceipt", () => {
  it("adjunta el comprobante y guarda una referencia sin firma", async () => {
    const { db, store, receipts } = setup();
    const pago = await pagoPendiente(db);

    const resultado = await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
    );

    expect(resultado).toMatchObject({
      paymentId: pago.paymentId,
      hasReceipt: true,
      byteLength: PNG.length,
      contentType: "image/png",
      replacedPrevious: false,
    });

    // Lo que se sube es exactamente lo que el cliente envió.
    expect(receipts.uploads).toHaveLength(1);
    expect(receipts.uploads[0]!.bytes).toEqual(PNG);
    expect(receipts.uploads[0]!.publicId.startsWith(`microcredito/payments/${pago.paymentId}/`)).toBe(true);

    // En Firestore queda la ruta de entrega, no una URL firmada ni el nombre que eligió el cliente.
    const reference = store.read("payments", pago.paymentId)!["receiptUrl"] as string;
    expect(reference).toMatch(
      new RegExp(`^image/authenticated/microcredito/payments/${pago.paymentId}/[0-9a-f-]{36}\\.png$`),
    );
    expect(reference).not.toContain("s--");
    expect(reference).not.toContain("comprobante.png");

    const audit = audits(store, AuditAction.PAYMENT_RECEIPT_UPLOADED);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: "uid-1",
      actorRole: Role.CUSTOMER,
      entityType: "payment",
      entityId: pago.paymentId,
    });
    expect(audit[0]!["metadata"]).toMatchObject({
      contentType: "image/png",
      bytes: PNG.length,
      format: "png",
    });
  });

  it("no paga nada: el pago sigue PENDING y ni la cuota ni el préstamo se mueven", async () => {
    const { db, store, receipts } = setup();
    const pago = await pagoPendiente(db);

    await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
    );

    expect(store.read("payments", pago.paymentId)!["status"]).toBe(PaymentStatus.PENDING);
    expect(store.read("loan_installments", "loan-1_1")!["status"]).toBe(InstallmentStatus.PENDING);
    expect(store.read("loan_installments", "loan-1_1")!["paidPesos"]).toBe(0);
    expect(store.read("loan_installments", "loan-1_1")!["pendingPaymentId"]).toBe(pago.paymentId);
    expect(store.read("loans", "loan-1")!["outstandingPesos"]).toBe(40_242);
    expect(store.read("loans", "loan-1")!["status"]).toBe(LoanStatus.DISBURSED);
    expect(store.read("loans", "loan-1")!["delinquencyStatus"]).toBeUndefined();
    expect(audits(store, AuditAction.PAYMENT_CONFIRMED)).toHaveLength(0);
    // Sanity: el enum de mora sigue siendo el que se espera, para que la aserción de arriba
    // signifique algo (si el nombre cambiara, `toBeUndefined` seguiría pasando en falso).
    expect(DelinquencyStatus.CURRENT).toBe("CURRENT");
  });

  it("un archivo inválido no sale del servidor: ni se sube ni se toca el documento", async () => {
    const { db, store, receipts } = setup();
    const pago = await pagoPendiente(db);

    await expectStatus(
      attachPaymentReceipt(
        { db, store: receipts },
        { paymentId: pago.paymentId, actor: CLIENTE, file: archivo({ filename: "malware.exe" }) },
      ),
      400,
    );

    expect(receipts.uploads).toHaveLength(0);
    expect(store.read("payments", pago.paymentId)!["receiptUrl"]).toBeUndefined();
    expect(audits(store, AuditAction.PAYMENT_RECEIPT_UPLOADED)).toHaveLength(0);
  });

  it("rechaza un pago ajeno con 404 y no sube el archivo de otro cliente", async () => {
    const { db, store, receipts } = setup();
    const pagoAjeno = await pagoPendiente(db, "loan-2", "loan-2_1");

    await expectStatus(
      attachPaymentReceipt(
        { db, store: receipts },
        { paymentId: pagoAjeno.paymentId, actor: CLIENTE, file: archivo() },
      ),
      404,
    );

    // Autorizar antes de la red: un cliente no puede meter archivos en el pago de otro.
    expect(receipts.uploads).toHaveLength(0);
    expect(store.read("payments", pagoAjeno.paymentId)!["receiptUrl"]).toBeUndefined();
  });

  it("un ADMIN no adjunta el comprobante de otro: lo declara el cliente", async () => {
    const { db, receipts } = setup();
    const pago = await pagoPendiente(db);

    await expectStatus(
      attachPaymentReceipt(
        { db, store: receipts },
        { paymentId: pago.paymentId, actor: ADMIN, file: archivo() },
      ),
      403,
    );

    expect(receipts.uploads).toHaveLength(0);
  });

  it("un id de pago con cara de ruta se rechaza antes de tocar el almacenamiento", async () => {
    const { db, receipts } = setup();
    await pagoPendiente(db);

    // El número de pago acaba en la ruta del archivo: tiene que estar verificado, no "no vacío".
    await expectStatus(
      attachPaymentReceipt(
        { db, store: receipts },
        { paymentId: "PAY-2026-0001/../../victima", actor: CLIENTE, file: archivo() },
      ),
      400,
    );
    expect(receipts.uploads).toHaveLength(0);
  });

  it("un pago ya resuelto no admite comprobante, y ni se llega a subir", async () => {
    const { db, store, receipts } = setup();
    const pago = await pagoPendiente(db);
    await confirmPayment({ db }, { paymentId: pago.paymentId, actor: ADMIN, idempotencyKey: "c-1" });

    await expectStatus(
      attachPaymentReceipt(
        { db, store: receipts },
        { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
      ),
      409,
    );

    // La comprobación es previa a la red: un pago resuelto no gasta ni un byte de almacenamiento.
    expect(receipts.uploads).toHaveLength(0);
    expect(store.read("payments", pago.paymentId)!["receiptUrl"]).toBeUndefined();
    expect(audits(store, AuditAction.PAYMENT_RECEIPT_UPLOADED)).toHaveLength(0);
  });

  it("si un admin resuelve el pago mientras se sube, el archivo huérfano se borra", async () => {
    // La carrera real: la lectura que autorizó la subida quedó vieja. La transacción es la que
    // decide, y lo que ya estaba en el proveedor se limpia.
    const { db, store, receipts } = setup();
    const pago = await pagoPendiente(db);
    receipts.onUpload = async () => {
      await confirmPayment({ db }, { paymentId: pago.paymentId, actor: ADMIN, idempotencyKey: "c-1" });
    };

    await expectStatus(
      attachPaymentReceipt(
        { db, store: receipts },
        { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
      ),
      409,
    );

    expect(receipts.uploads).toHaveLength(1);
    expect(receipts.destroyed.map((r) => r.publicId)).toEqual([receipts.uploads[0]!.publicId]);
    expect(store.read("payments", pago.paymentId)!["receiptUrl"]).toBeUndefined();
    expect(audits(store, AuditAction.PAYMENT_RECEIPT_UPLOADED)).toHaveLength(0);
  });

  it("reemplaza un comprobante previo y borra el anterior del almacenamiento", async () => {
    const { db, store, receipts } = setup();
    const pago = await pagoPendiente(db);
    await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
    );
    // Se lee entre las dos subidas: el mock entrega el documento vivo, no una copia.
    const referenceAntes = store.read("payments", pago.paymentId)!["receiptUrl"] as string;

    const segundo = await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: pago.paymentId, actor: CLIENTE, file: archivo({ filename: "otro.png" }) },
    );

    expect(segundo.replacedPrevious).toBe(true);

    const referenceDespues = store.read("payments", pago.paymentId)!["receiptUrl"] as string;
    expect(referenceDespues).not.toBe(referenceAntes);
    // Solo se borra el anterior: el nuevo sigue ahí para poder firmarse.
    expect(receipts.destroyed).toHaveLength(1);
    expect(buildReceiptReference(receipts.destroyed[0]!)).toBe(referenceAntes);
    expect(receipts.uploads[1]!.publicId).not.toBe(receipts.uploads[0]!.publicId);
  });

  it("si el almacenamiento está caído, el pago queda intacto y se puede reintentar", async () => {
    const { db, store, receipts } = setup();
    const pago = await pagoPendiente(db);
    receipts.failUpload = new ReceiptStorageError("No se pudo subir el comprobante: red caída", 503);

    await expectStatus(
      attachPaymentReceipt(
        { db, store: receipts },
        { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
      ),
      503,
    );
    expect(store.read("payments", pago.paymentId)!["receiptUrl"]).toBeUndefined();

    // Reintento: el mismo pago sigue pendiente y ahora sí admite el comprobante.
    receipts.failUpload = null;
    const reintento = await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
    );
    expect(reintento.hasReceipt).toBe(true);
  });

  it("no deja datos de auditoría cuando la subida falla", async () => {
    const { db, store, receipts } = setup();
    const pago = await pagoPendiente(db);
    receipts.failUpload = new ReceiptStorageError("caída", 502);

    await expectStatus(
      attachPaymentReceipt(
        { db, store: receipts },
        { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
      ),
      500,
    );
    expect(audits(store, AuditAction.PAYMENT_RECEIPT_UPLOADED)).toHaveLength(0);
  });
});

describe("getPaymentReceiptUrl", () => {
  it("firma bajo demanda, con caducidad corta, y no guarda la URL en el documento", async () => {
    const { db, store, receipts } = setup();
    const pago = await pagoPendiente(db);
    await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
    );

    const antes = Date.now();
    const vista = await getPaymentReceiptUrl(
      { db, store: receipts },
      { paymentId: pago.paymentId, actor: CLIENTE },
    );

    expect(vista.paymentId).toBe(pago.paymentId);
    expect(vista.url).toContain(receipts.signed[0]!.reference.publicId);
    expect(receipts.signed[0]!.ttlSeconds).toBe(300);
    // La caducidad es real: entre 4 y 5 minutos desde ahora.
    const restante = new Date(vista.expiresAt).getTime() - antes;
    expect(restante).toBeGreaterThan(4 * 60 * 1000);
    expect(restante).toBeLessThanOrEqual(300 * 1000 + 1000);
    // Lo guardado sigue siendo la referencia sin firma.
    expect(store.read("payments", pago.paymentId)!["receiptUrl"] as string).not.toContain("firma.invalida");
  });

  it("el titular ve su comprobante y un ADMIN el de cualquiera", async () => {
    const { db, receipts } = setup();
    const pago = await pagoPendiente(db);
    await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
    );

    await expect(
      getPaymentReceiptUrl({ db, store: receipts }, { paymentId: pago.paymentId, actor: ADMIN }),
    ).resolves.toMatchObject({ paymentId: pago.paymentId });
    await expect(
      getPaymentReceiptUrl({ db, store: receipts }, { paymentId: pago.paymentId, actor: CLIENTE }),
    ).resolves.toMatchObject({ paymentId: pago.paymentId });
  });

  it("el comprobante de otro cliente es 404, y no se firma nada", async () => {
    const { db, receipts } = setup();
    const pagoAjeno = await pagoPendiente(db, "loan-2", "loan-2_1");
    await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: pagoAjeno.paymentId, actor: OTRO_CLIENTE, file: archivo() },
    );

    await expectStatus(
      getPaymentReceiptUrl({ db, store: receipts }, { paymentId: pagoAjeno.paymentId, actor: CLIENTE }),
      404,
    );
    expect(receipts.signed).toHaveLength(0);
  });

  it("un pago sin comprobante responde 404: el comprobante es opcional de verdad", async () => {
    const { db, receipts } = setup();
    const pago = await pagoPendiente(db);

    await expectStatus(
      getPaymentReceiptUrl({ db, store: receipts }, { paymentId: pago.paymentId, actor: CLIENTE }),
      404,
    );
  });

  it("sigue viendo el comprobante de un pago ya confirmado", async () => {
    // La evidencia de un pago resuelto es justo lo que un admin necesita para una disputa.
    const { db, receipts } = setup();
    const pago = await pagoPendiente(db);
    await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
    );
    await confirmPayment({ db }, { paymentId: pago.paymentId, actor: ADMIN, idempotencyKey: "c-1" });

    await expect(
      getPaymentReceiptUrl({ db, store: receipts }, { paymentId: pago.paymentId, actor: ADMIN }),
    ).resolves.toMatchObject({ paymentId: pago.paymentId });
  });

  it("una referencia corrupta en el documento es un 500, no la firma de una ruta inventada", async () => {
    const { db, store, receipts } = setup();
    const pago = await pagoPendiente(db);
    // Simula un documento escrito a mano o un `public_id` de otra familia de archivos.
    store.seed("payments", pago.paymentId, {
      ...store.read("payments", pago.paymentId),
      receiptUrl: "image/authenticated/otra-carpeta/apropiado.png",
    });

    await expectStatus(
      getPaymentReceiptUrl({ db, store: receipts }, { paymentId: pago.paymentId, actor: ADMIN }),
      500,
    );
    expect(receipts.signed).toHaveLength(0);
  });

  it("propaga el 503 del almacenamiento sin ocultarlo como un 500 genérico", async () => {
    const { db, receipts } = setup();
    const pago = await pagoPendiente(db);
    await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: pago.paymentId, actor: CLIENTE, file: archivo() },
    );
    receipts.failSign = new ReceiptStorageError("almacenamiento no configurado", 503);

    await expectStatus(
      getPaymentReceiptUrl({ db, store: receipts }, { paymentId: pago.paymentId, actor: ADMIN }),
      503,
    );
  });
});

describe("errores del servicio", () => {
  it("el pago de otro cliente se resuelve como 404 y no como 403", async () => {
    // El mismo `AppError` de 404 se propaga tal cual: la ruta lo traduce a respuesta.
    const { db, receipts } = setup();
    const pagoAjeno = await pagoPendiente(db, "loan-2", "loan-2_1");
    const error = await attachPaymentReceipt(
      { db, store: receipts },
      { paymentId: pagoAjeno.paymentId, actor: CLIENTE, file: archivo() },
    ).then(
      () => null,
      (e: unknown) => e as AppError,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error?.statusCode).toBe(404);
    expect(error?.code).toBe("NOT_FOUND");
  });
});
