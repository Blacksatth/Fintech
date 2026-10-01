import { type Firestore, type Transaction } from "firebase-admin/firestore";
import { AuditAction, Role } from "@/server/types";
import type { PaymentDoc } from "@/server/payment-doc";
import { assertOwnedBy } from "@/server/ownership";
import {
  assertPaymentAcceptsReceipt,
  assertPaymentNumber,
  PaymentError,
} from "@/server/payments";
import {
  ReceiptError,
  ReceiptStorageError,
  RECEIPT_URL_TTL_SECONDS,
  buildReceiptReference,
  newReceiptPublicId,
  parseReceiptReference,
  validateReceipt,
  type ReceiptCandidate,
  type ReceiptReference,
  type ReceiptStore,
  type ValidatedReceipt,
} from "@/server/receipt";
import { badRequest, conflict, forbidden, internal, notFound, serviceUnavailable } from "@/lib/errors";
import type { PaymentActor } from "./payment-service";

/**
 * Comprobantes de pago (PROJECT_SPEC §11, F10-3).
 *
 * Adjuntar un comprobante **no paga nada**: solo deja la evidencia de un pago que sigue `PENDING`
 * hasta que un ADMIN lo confirme (F10-2b). Por eso este servicio no toca el estado del pago ni el
 * de la cuota ni el saldo del préstamo: escribe `payments.receiptUrl` y la auditoría.
 *
 * El almacenamiento entra por `ReceiptStore` (interfaz en `src/server/receipt.ts`), así que los
 * tests usan un doble en memoria y la app usa Cloudinary con entrega restringida.
 */

export interface ReceiptDeps {
  db: Firestore;
  store: ReceiptStore;
}

export interface AttachReceiptInput {
  paymentId: string;
  actor: PaymentActor;
  file: ReceiptCandidate;
}

export interface ReceiptView {
  paymentId: string;
  hasReceipt: boolean;
  byteLength: number;
  contentType: string;
  /** `true` cuando este comprobante sustituyó a otro que ya estaba en el pago. */
  replacedPrevious: boolean;
}

export interface ReceiptUrlView {
  paymentId: string;
  /** URL firmada con caducidad corta. Es una credencial temporal: no se persiste en el doc. */
  url: string;
  expiresAt: string;
}

/** Traduce el error de dominio a una respuesta HTTP sin perder su código. */
function toHttp(error: unknown): never {
  if (error instanceof ReceiptError || error instanceof PaymentError) {
    if (error.statusCode === 400) throw badRequest(error.message);
    if (error.statusCode === 403) throw forbidden(error.message);
    if (error.statusCode === 404) throw notFound(error.message);
    throw conflict(error.message);
  }
  if (error instanceof ReceiptStorageError) {
    // El almacenamiento caído no es culpa de quien subió el archivo: es 503, no un error de
    // validación. El pago ya registrado no se toca y se puede reintentar la subida.
    if (error.statusCode === 503) throw serviceUnavailable(error.message);
    throw internal(error.message);
  }
  throw error;
}

function assertOwnerActor(actor: PaymentActor): void {
  if (!actor.uid) {
    throw badRequest("Actor no identificado");
  }
  // El comprobante lo declara quien pagó. Un ADMIN no lo sube por el cliente: si el cliente no
  // pudo adjuntarlo, la referencia escrita al registrar el pago es la evidencia.
  if (actor.role !== Role.CUSTOMER) {
    throw forbidden("Solo el titular del pago puede adjuntar su comprobante");
  }
}

/**
 * Lectura previa: ¿este pago existe, es del actor y sigue pendiente?
 *
 * Va **antes** de subir nada. Autorizar después de subir significaría que un cliente que no es el
 * titular puede meter archivos en el almacenamiento del pago ajeno (y que el rechazo solo se
 *enticera cuando el archivo ya está en el proveedor). Aquí se responde primero, sin consumir un
 * solo byte de ancho de banda; y la misma condición se vuelve a comprobar dentro de la
 * transacción, que es la que decide.
 */
async function loadOwnedPayment(db: Firestore, paymentId: string, actor: PaymentActor): Promise<PaymentDoc> {
  const snap = await db.collection("payments").doc(paymentId).get();
  if (!snap.exists) {
    throw notFound("Pago no encontrado");
  }
  const payment = snap.data() as PaymentDoc;
  assertOwnedBy(payment, actor.uid, "Pago no encontrado");
  assertPaymentAcceptsReceipt(payment);
  return payment;
}

interface AttachInTransactionInput {
  paymentId: string;
  actor: PaymentActor;
  reference: ReceiptReference;
  receipt: ValidatedReceipt;
  now: Date;
}

interface AttachInTransactionOutput {
  previous?: ReceiptReference;
}

/**
 * Escritura del doc y de la auditoría, en una transacción.
 *
 * Las comprobaciones se repiten **dentro** de la transacción aunque ya se hubieran hecho antes de
 * subir el archivo: entre la lectura que autorizó la subida y este punto, un ADMIN pudo confirmar
 * o rechazar el pago, y el estado que decide es el de este momento.
 */
async function attachInTransaction(
  db: Firestore,
  tx: Transaction,
  input: AttachInTransactionInput,
): Promise<AttachInTransactionOutput> {
  const paymentRef = db.collection("payments").doc(input.paymentId);
  const snap = await tx.get(paymentRef);
  if (!snap.exists) {
    throw notFound("Pago no encontrado");
  }
  const payment = snap.data() as PaymentDoc;
  assertOwnedBy(payment, input.actor.uid, "Pago no encontrado");
  assertPaymentAcceptsReceipt(payment);

  const previous =
    payment.receiptUrl === undefined
      ? undefined
      : (parseReceiptReference(payment.receiptUrl, payment.paymentNumber) ?? undefined);

  tx.update(paymentRef, {
    receiptUrl: buildReceiptReference(input.reference),
    updatedAt: input.now,
  });
  tx.set(db.collection("audit_logs").doc(), {
    actorId: input.actor.uid,
    actorRole: input.actor.role,
    action: AuditAction.PAYMENT_RECEIPT_UPLOADED,
    entityType: "payment",
    entityId: payment.paymentNumber,
    metadata: {
      loanId: payment.loanId,
      installmentId: payment.installmentId,
      amountPesos: payment.amountPesos,
      contentType: input.receipt.contentType,
      bytes: input.receipt.byteLength,
      format: input.reference.format,
      replacedPrevious: previous !== undefined,
    },
    createdAt: input.now,
  });

  return { previous };
}

/**
 * Sube el comprobante de un pago `PENDING` y deja la referencia en el documento.
 *
 * El orden importa: primero se valida (puro, sin red), después se sube, y solo entonces se
 * escribe. Un archivo rechazado nunca sale del servidor, y una subida que no llega a Firestore
 * deja el documento intacto — el pago sigue `PENDING` y se puede reintentar, que es lo que pide
 * §11 ("un fallo no altera el estado del pago").
 *
 * Reemplazar el comprobante de un pago `PENDING` está permitido: el cliente se equivocó de
 * archivo. El anterior se borra del proveedor para no dejar evidencia huérfana.
 */
export async function attachPaymentReceipt(
  deps: ReceiptDeps,
  input: AttachReceiptInput,
): Promise<ReceiptView> {
  assertOwnerActor(input.actor);
  assertPaymentNumber(input.paymentId);

  // Validación pura: si el archivo no sirve, no se consume ni un byte de ancho de banda.
  let receipt: ValidatedReceipt;
  try {
    receipt = validateReceipt(input.file);
  } catch (error) {
    toHttp(error);
  }

  // Autorización antes de la red: ni un archivo ajeno sale del servidor, ni uno de un pago ya
  // resuelto llega a gastarse como almacenamiento.
  try {
    await loadOwnedPayment(deps.db, input.paymentId, input.actor);
  } catch (error) {
    toHttp(error);
  }

  // El public_id lleva el número de pago ya validado por `assertPaymentNumber`: es un segmento de
  // ruta en el proveedor, y ese patrón descarta `/`, `..` y cualquier otra cosa.
  const reference: ReceiptReference = {
    publicId: newReceiptPublicId(input.paymentId),
    format: receipt.extension,
  };

  try {
    const uploaded = await deps.store.upload({
      publicId: reference.publicId,
      bytes: receipt.bytes,
      contentType: receipt.contentType,
    });
    // El proveedor es la autoridad sobre el `public_id` y el formato con el que guardó el asset.
    reference.publicId = uploaded.publicId;
    reference.format = uploaded.format;
  } catch (error) {
    // Nada se ha escrito en Firestore todavía: el pago sigue exactamente como estaba.
    toHttp(error);
  }

  let previous: ReceiptReference | undefined;
  try {
    const outcome = await deps.db.runTransaction((tx) =>
      attachInTransaction(deps.db, tx, {
        paymentId: input.paymentId,
        actor: input.actor,
        reference,
        receipt,
        now: new Date(),
      }),
    );
    previous = outcome.previous;
  } catch (error) {
    // El archivo ya está en el proveedor pero el documento no lo apunta. Se borra: un
    // comprobante que nadie puede ver ni auditar es solo un archivo muerto.
    await deps.store.destroy(reference).catch(() => undefined);
    toHttp(error);
  }

  if (previous && previous.publicId !== reference.publicId) {
    await deps.store.destroy(previous);
  }

  return {
    paymentId: input.paymentId,
    hasReceipt: true,
    byteLength: receipt.byteLength,
    contentType: receipt.contentType,
    replacedPrevious: previous !== undefined,
  };
}

/**
 * URL **firmada** del comprobante, para el titular o para un ADMIN.
 *
 * Se firma bajo demanda y caduca en `RECEIPT_URL_TTL_SECONDS`: guardar una URL firmada en el
 * documento la convertiría en una credencial permanente, que es justo lo que la entrega
 * restringida evita.
 */
export async function getPaymentReceiptUrl(
  deps: ReceiptDeps,
  input: { paymentId: string; actor: PaymentActor },
): Promise<ReceiptUrlView> {
  if (!input.actor.uid) {
    throw badRequest("Actor no identificado");
  }
  if (input.actor.role !== Role.CUSTOMER && input.actor.role !== Role.ADMIN) {
    throw forbidden("No autorizado a ver comprobantes de pago");
  }
  assertPaymentNumber(input.paymentId);

  const snap = await deps.db.collection("payments").doc(input.paymentId).get();
  if (!snap.exists) {
    throw notFound("Pago no encontrado");
  }
  const payment = snap.data() as PaymentDoc;
  // El ADMIN llega por su rol (§9 `owner/ADMIN`); para el titular, un pago ajeno es 404 y no un
  // 403, que revelaría que ese pago existe.
  if (input.actor.role === Role.CUSTOMER) {
    assertOwnedBy(payment, input.actor.uid, "Pago no encontrado");
  }

  if (payment.receiptUrl === undefined || payment.receiptUrl.length === 0) {
    throw notFound("Este pago no tiene comprobante adjunto");
  }

  const reference = parseReceiptReference(payment.receiptUrl, payment.paymentNumber);
  if (reference === null) {
    // Referencia que no cumple el formato: es corrupción de datos, no un error del cliente. 500 y
    // no se firma nada, antes que firmar una ruta que podría no ser la del comprobante.
    throw internal(
      `El comprobante del pago ${payment.paymentNumber} tiene una referencia inválida: revísalo a mano`,
    );
  }

  let url: string;
  try {
    url = deps.store.signedDeliveryUrl(reference, RECEIPT_URL_TTL_SECONDS);
  } catch (error) {
    toHttp(error);
  }

  return {
    paymentId: payment.paymentNumber,
    url,
    expiresAt: new Date(Date.now() + RECEIPT_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/** Un pago sin comprobante sigue siendo un pago: se consulta sin que exista archivo. */
export function paymentHasReceipt(payment: Pick<PaymentDoc, "receiptUrl">): boolean {
  return typeof payment.receiptUrl === "string" && payment.receiptUrl.length > 0;
}
