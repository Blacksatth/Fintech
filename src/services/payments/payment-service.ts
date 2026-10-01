import { type Firestore, type Transaction, FieldValue } from "firebase-admin/firestore";
import {
  AuditAction,
  Currency,
  DelinquencyStatus,
  InstallmentStatus,
  LoanStatus,
  PaymentStatus,
  Role,
  ActorType,
} from "@/server/types";
import type { LoanDoc, LoanInstallmentDoc, SystemConfigDoc } from "@/server/credit-doc";
import { loanInstallmentDocId } from "@/server/credit-doc";
import {
  buildPaymentDoc,
  buildPaymentEventDoc,
  paymentEventDocId,
  type PaymentDoc,
} from "@/server/payment-doc";
import {
  PaymentError,
  assertLoanAcceptsPayments,
  assertPayableInstallment,
  confirmPaymentState,
  effectConfirmInstallment,
  effectRejectInstallment,
  effectReverseInstallment,
  formatPaymentNumber,
  normalizePaymentReference,
  parsePaymentNumberSequence,
  rejectPaymentState,
  reversePaymentState,
  type InstallmentTransition,
} from "@/server/payments";
import {
  DelinquencyError,
  parseDelinquencyThresholds,
  recalcLoanDelinquency,
  type DelinquencyThresholds,
} from "@/server/delinquency";
import { assertOwnedBy } from "@/server/ownership";
import { badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import { withIdempotency } from "@/lib/idempotency";
import { stripUndefined } from "@/server/doc";
import { getActivePaymentChannel } from "@/services/payments/payment-channel-service";
import { loanRecalcPatch, loanStatusAfterRecalc } from "@/services/credit/loan-recalc";

/**
 * Registro de pagos del cliente (PROJECT_SPEC §11, F10-2a) y su resolución manual por un ADMIN
 * (F10-2b): confirmar, rechazar y reversar.
 *
 * El cliente **no manda el importe**: registra que pagó y por dónde; el saldo de la cuota lo
 * decide el servidor dentro de la transacción. Un pago nace `PENDING` y no paga nada hasta que
 * un ADMIN lo confirme a mano; aquí no existe ningún camino que confirme solo.
 *
 * Idempotencia con el patrón de `disbursement-service`: `idempotency_keys` impide repetir la
 * operación y la respuesta se reconstruye leyendo `payments/{paymentNumber}`.
 */

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface PaymentDeps {
  db: Firestore;
}

export interface PaymentActor {
  uid: string;
  role: string;
}

export interface CreatePaymentInput {
  loanId: string;
  installmentId: string;
  /** ID de `payment_channels` (su `type`). */
  channel: string;
  /** Referencia que el cliente dice haber usado, si la tiene. */
  reference?: string;
  actor: PaymentActor;
  /** `Idempotency-Key` del cliente. Reobligatorio: un pago nunca se registra dos veces. */
  idempotencyKey: string;
}

export interface PaymentView {
  /** Doc ID de `payments`: coincide con `paymentNumber`. */
  paymentId: string;
  paymentNumber: string;
  userId: string;
  loanId: string;
  installmentId: string;
  amountPesos: number;
  currency: Currency;
  channel: string;
  reference?: string;
  status: PaymentStatus;
  /** Estado de la cuota en el momento de la lectura: el pago aún no la movió. */
  installmentStatus: InstallmentStatus;
  createdAt: Date;
}

export interface PaymentResult extends PaymentView {
  replayed: boolean;
}

function assertCustomer(actor: PaymentActor): void {
  if (!actor.uid) {
    throw badRequest("Actor no identificado");
  }
  if (actor.role !== Role.CUSTOMER) {
    throw forbidden("Solo el titular del préstamo puede registrar pagos");
  }
}

function assertIdempotencyKey(key: string | undefined): asserts key is string {
  if (!key || key.trim().length === 0) {
    throw badRequest("Falta el encabezado Idempotency-Key");
  }
}

/** Traduce el error de dominio a una respuesta HTTP sin perder su código. */
function toHttp(error: unknown): never {
  if (error instanceof PaymentError || error instanceof DelinquencyError) {
    if (error.statusCode === 400) throw badRequest(error.message);
    if (error.statusCode === 403) throw forbidden(error.message);
    if (error.statusCode === 404) throw notFound(error.message);
    throw conflict(error.message);
  }
  throw error;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "object" && value !== null && "toMillis" in value) {
    return new Date((value as { toMillis(): number }).toMillis());
  }
  throw new Error("payment-service: fecha esperada no reconocida");
}

/**
 * Mayor `paymentNumber` del año, leído **dentro** de la transacción que escribe el nuevo pago.
 *
 * Leer fuera y escribir después es read-then-write: dos registros simultáneos elegirían el
 * mismo número. Aquí no, porque el doc ID **es** el número: la segunda transacción choca en la
 * misma ruta, Firestore la aborta, la reintenta y ya ve el número usado. Mismo patrón que
 * `findHighestApplicationNumber`, y con la misma ventaja: la query es de rango sobre un solo
 * campo, que el índice simple de Firestore resuelve sin índice compuesto.
 */
async function findHighestPaymentNumber(db: Firestore, tx: Transaction, year: number): Promise<number> {
  const prefix = `PAY-${year}-`;
  const query = db
    .collection("payments")
    .where("paymentNumber", ">=", prefix)
    .where("paymentNumber", "<", `${prefix}~`)
    .orderBy("paymentNumber", "desc")
    .limit(1);

  const snap = await tx.get(query);
  if (snap.empty) return 0;
  return parsePaymentNumberSequence(snap.docs[0].data().paymentNumber as string, year);
}

async function createInTransaction(
  db: Firestore,
  tx: Transaction,
  input: CreatePaymentInput,
  now: Date,
): Promise<{ entityId: string }> {
  const loanSnap = await tx.get(db.collection("loans").doc(input.loanId));
  // 404 y no 403 si el préstamo es de otro: un 403 confirmaría que el id existe (ver
  // `assertOwnedBy`).
  const loan = assertOwnedBy(
    loanSnap.exists ? (loanSnap.data() as LoanDoc) : null,
    input.actor.uid,
    "Préstamo no encontrado",
  );
  assertLoanAcceptsPayments(loan);

  const installmentSnap = await tx.get(db.collection("loan_installments").doc(input.installmentId));
  if (!installmentSnap.exists) {
    throw notFound("Cuota no encontrada");
  }
  // El importe sale de la cuota, nunca del request: `assertPayableInstallment` devuelve el saldo
  // ya validado y ese valor es el que se escribe.
  const amountPesos = assertPayableInstallment(installmentSnap.data() as LoanInstallmentDoc, {
    loanId: input.loanId,
    installmentId: input.installmentId,
  });

  const year = now.getFullYear();
  const paymentNumber = formatPaymentNumber(year, (await findHighestPaymentNumber(db, tx, year)) + 1);

  const payment = buildPaymentDoc(
    {
      paymentNumber,
      userId: input.actor.uid,
      loanId: input.loanId,
      installmentId: input.installmentId,
      amountPesos,
      currency: Currency.COP,
      channel: input.channel,
      reference: input.reference,
      idempotencyKey: input.idempotencyKey,
    },
    now,
  );

  tx.set(db.collection("payments").doc(paymentNumber), stripUndefined(payment));

  // Candado de la cuota. Se escribe en esta misma transacción, así que dos registros
  // simultáneos de la misma cuota se serializan: el que pierde el reintento ve el candado y
  // recibe 409 en vez de dejar un segundo pago PENDING (lo libera el rechazo, F10-2b).
  tx.update(db.collection("loan_installments").doc(input.installmentId), {
    pendingPaymentId: paymentNumber,
  });

  tx.set(db.collection("audit_logs").doc(), {
    actorId: input.actor.uid,
    actorRole: input.actor.role,
    action: AuditAction.PAYMENT_CREATED,
    entityType: "payment",
    entityId: paymentNumber,
    metadata: {
      loanId: input.loanId,
      installmentId: input.installmentId,
      amountPesos,
      currency: Currency.COP,
      channel: input.channel,
      reference: payment.reference ?? null,
      status: PaymentStatus.PENDING,
      idempotencyKey: input.idempotencyKey,
    },
    createdAt: now,
  });

  return { entityId: paymentNumber };
}

interface LoadedPayment {
  payment: PaymentDoc;
  installment: LoanInstallmentDoc;
}

/** Pago y su cuota. No decide quién puede verlo: eso es responsabilidad del llamador. */
async function loadPayment(db: Firestore, paymentId: string): Promise<LoadedPayment> {
  const paymentSnap = await db.collection("payments").doc(paymentId).get();
  if (!paymentSnap.exists) {
    throw notFound("Pago no encontrado");
  }
  const payment = paymentSnap.data() as PaymentDoc;
  const installmentSnap = await db.collection("loan_installments").doc(payment.installmentId).get();
  if (!installmentSnap.exists) {
    throw conflict(`El pago ${paymentId} apunta a una cuota que no existe: no se puede mostrar`);
  }
  return { payment, installment: installmentSnap.data() as LoanInstallmentDoc };
}

function toView({ payment, installment }: LoadedPayment, paymentId: string): PaymentView {
  return stripUndefined({
    paymentId,
    paymentNumber: payment.paymentNumber,
    userId: payment.userId,
    loanId: payment.loanId,
    installmentId: payment.installmentId,
    amountPesos: payment.amountPesos,
    currency: payment.currency,
    channel: payment.channel,
    reference: payment.reference,
    status: payment.status,
    installmentStatus: installment.status,
    createdAt: toDate(payment.createdAt),
  }) as unknown as PaymentView;
}

/** Reconstruye la respuesta leyendo la entidad, nunca el registro de idempotencia. */
async function readView(db: Firestore, paymentId: string, userId: string): Promise<PaymentView> {
  const loaded = await loadPayment(db, paymentId);
  // El registro de idempotencia decide si es un replay, no *qué* pago es: la propiedad se vuelve
  // a exigir sobre el doc leído. Así, ni una colisión de claves puede devolver el pago de otro.
  assertOwnedBy(loaded.payment, userId, "Pago no encontrado");
  return toView(loaded, paymentId);
}

/**
 * Registra un pago `PENDING` de una cuota.
 *
 * Idempotente por `Idempotency-Key` con scope por cuota (`payment.create:{installmentId}`): la
 * misma clave sobre la misma cuota devuelve el mismo pago, y una clave distinta es una
 * operación nueva —que en la práctica chocará con el candado de la cuota si la anterior sigue
 * pendiente.
 */
export async function createPayment(deps: PaymentDeps, input: CreatePaymentInput): Promise<PaymentResult> {
  assertCustomer(input.actor);
  assertIdempotencyKey(input.idempotencyKey);

  // El canal se valida fuera de la transacción: es configuración, no un invariante de dinero, y
  // un canal inactivo es indistinguible de uno inexistente para quien paga.
  const channel = await getActivePaymentChannel(deps, input.channel);
  if (channel === null) {
    throw badRequest("El canal de pago no existe o está inactivo");
  }
  const reference = normalizePaymentReference(input.reference);

  const now = new Date();
  let outcome: Awaited<ReturnType<typeof withIdempotency>>;
  try {
    outcome = await withIdempotency(deps.db, {
      scope: `payment.create:${input.installmentId}`,
      key: input.idempotencyKey,
      entityType: "payment",
      ttlMs: IDEMPOTENCY_TTL_MS,
      run: (tx) => createInTransaction(deps.db, tx, { ...input, reference }, now),
    });
  } catch (error) {
    toHttp(error);
  }

  if (outcome.entityId === undefined) {
    // Solo alcanzable con un registro de idempotencia antiguo sin `entityId`. Fallar es mejor
    // que devolver un pago inventado.
    throw conflict("No se pudo determinar el pago registrado: repita la operación con una clave nueva");
  }

  const view = await readView(deps.db, outcome.entityId, input.actor.uid);
  return { ...view, replayed: outcome.replayed };
}

/**
 * Un pago por id, con ownership verificado. 404 tanto si no existe como si es de otro cliente:
 * un 403 revelaría la existencia de pagos ajenos.
 */
export async function getPaymentForUser(
  deps: PaymentDeps,
  input: { paymentId: string; userId: string },
): Promise<PaymentView> {
  assertPaymentId(input.paymentId);
  return readView(deps.db, input.paymentId, input.userId);
}

/**
 * El mismo pago para un ADMIN, que sí puede ver pagos de cualquier cliente (§9: `owner/ADMIN`).
 * El permiso lo da el rol, no el doc: por eso aquí no se re-exige la propiedad.
 */
export async function getPaymentForAdmin(
  deps: PaymentDeps,
  input: { paymentId: string },
): Promise<PaymentView> {
  assertPaymentId(input.paymentId);
  return toView(await loadPayment(deps.db, input.paymentId), input.paymentId);
}

function assertPaymentId(paymentId: string): void {
  if (!paymentId || paymentId.trim().length === 0) {
    throw badRequest("Falta el id del pago");
  }
}

/** ==================== Resolución por ADMIN (F10-2b) ==================== */

export interface ResolvePaymentInput {
  paymentId: string;
  actor: PaymentActor;
  idempotencyKey: string;
  /** Solo reject/reverse: motivo obligatorio y auditable. */
  reason?: string;
  /** Solo confirm: nota interna del admin (opcional). */
  adminNote?: string;
}

export interface AdminPaymentResult {
  paymentId: string;
  paymentNumber: string;
  userId: string;
  loanId: string;
  installmentId: string;
  amountPesos: number;
  currency: Currency;
  status: PaymentStatus;
  confirmedBy?: string;
  confirmedAt?: Date;
  rejectedBy?: string;
  rejectedAt?: Date;
  reason?: string;
  /** Re-cálculo del préstamo tras la operación (`recalcLoanDelinquency`). */
  loan: {
    status: LoanStatus;
    delinquencyStatus: DelinquencyStatus;
    daysPastDue: number;
    outstandingPesos: number;
  };
  replayed: boolean;
}

function assertAdmin(actor: PaymentActor): void {
  if (!actor.uid) {
    throw badRequest("Actor no identificado");
  }
  if (actor.role !== Role.ADMIN) {
    throw forbidden("Solo un administrador puede resolver el pago");
  }
}

/**
 * El slot de evento del pago debe estar libre: cada transición se registra una sola vez en
 * `payment_events` (la confirmación de un mismo pago **no** puede producir `_1` dos veces).
 * La idempotencia ya lo impide para la misma clave; este guard también protege una clave
 * distinta que entrara en carrera.
 */
async function assertEventSlotFree(
  db: Firestore,
  tx: Transaction,
  payment: PaymentDoc,
  sequence: number,
): Promise<void> {
  const snap = await tx.get(db.collection("payment_events").doc(paymentEventDocId(payment.paymentNumber, sequence)));
  if (snap.exists) {
    throw conflict(`La transición ${payment.paymentNumber}_${sequence} ya se registró: no se repite`);
  }
}

function auditPayment(
  db: Firestore,
  tx: Transaction,
  action: AuditAction,
  actor: PaymentActor,
  payment: PaymentDoc,
  now: Date,
  metadata: Record<string, unknown>,
): void {
  tx.set(db.collection("audit_logs").doc(), {
    actorId: actor.uid,
    actorRole: actor.role,
    action,
    entityType: "payment",
    entityId: payment.paymentNumber,
    metadata: {
      loanId: payment.loanId,
      installmentId: payment.installmentId,
      amountPesos: payment.amountPesos,
      currency: payment.currency,
      ...metadata,
    },
    createdAt: now,
  });
}

/** El fixture de un `update` Firestore de cuota: lo que se escribe y lo que se borra. */
function toInstallmentPatch(transition: InstallmentTransition): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...transition.set };
  for (const campo of transition.unset) {
    patch[campo] = FieldValue.delete();
  }
  return patch;
}

async function readLoan(db: Firestore, tx: Transaction, loanId: string): Promise<LoanDoc> {
  const snap = await tx.get(db.collection("loans").doc(loanId));
  if (!snap.exists) {
    throw notFound("Préstamo no encontrado");
  }
  return snap.data() as LoanDoc;
}

async function readPaymentInTx(db: Firestore, tx: Transaction, paymentId: string): Promise<PaymentDoc> {
  const snap = await tx.get(db.collection("payments").doc(paymentId));
  if (!snap.exists) {
    throw notFound("Pago no encontrado");
  }
  return snap.data() as PaymentDoc;
}

async function readInstallment(
  db: Firestore,
  tx: Transaction,
  installmentId: string,
): Promise<LoanInstallmentDoc> {
  const snap = await tx.get(db.collection("loan_installments").doc(installmentId));
  if (!snap.exists) {
    throw notFound("Cuota no encontrada");
  }
  return snap.data() as LoanInstallmentDoc;
}

async function readAllInstallments(
  db: Firestore,
  tx: Transaction,
  loanId: string,
  termInstallments: number | undefined,
): Promise<LoanInstallmentDoc[]> {
  if (termInstallments === undefined) {
    throw conflict(
      "El préstamo no tiene snapshot de pricing: no se puede recalcular su saldo (requiere migración de datos)",
    );
  }
  const refs = Array.from({ length: termInstallments }, (_, i) =>
    db.collection("loan_installments").doc(loanInstallmentDocId(loanId, i + 1)),
  );
  const snaps = await tx.getAll(...refs);
  const faltante = snaps.find((snap) => !snap.exists);
  if (faltante !== undefined) {
    throw conflict(
      `El préstamo no tiene la cuota ${faltante.id}: no se recalcula su saldo sobre datos incompletos`,
    );
  }
  return snaps.map((snap) => snap.data() as LoanInstallmentDoc);
}

async function readDelinquencyThresholds(
  db: Firestore,
  tx: Transaction,
): Promise<DelinquencyThresholds> {
  const snap = await tx.get(db.collection("system_config").doc("delinquency"));
  const value = snap.exists ? (snap.data() as SystemConfigDoc).value : undefined;
  return parseDelinquencyThresholds(value);
}

/** Aplica la transición de cuota en memoria para que el recálculo vea el estado final. */
function applyTransition(
  installment: LoanInstallmentDoc,
  transition: InstallmentTransition,
): LoanInstallmentDoc {
  const next = { ...installment, ...transition.set } as LoanInstallmentDoc;
  for (const campo of transition.unset) {
    delete next[campo];
  }
  return next;
}

async function confirmInTransaction(
  db: Firestore,
  tx: Transaction,
  input: ResolvePaymentInput,
  now: Date,
): Promise<void> {
  // Todas las lecturas van primero: Firestore exige reads antes de writes dentro de una
  // transacción (trampa real que el mock no detecta).
  const payment = await readPaymentInTx(db, tx, input.paymentId);
  await assertEventSlotFree(db, tx, payment, 1);
  const loan = await readLoan(db, tx, payment.loanId);
  const installment = await readInstallment(db, tx, payment.installmentId);

  const settled = confirmPaymentState(payment, {
    confirmedBy: input.actor.uid,
    confirmedAt: now,
    adminNote: input.adminNote,
  });
  const transition = effectConfirmInstallment(installment, settled, now);

  const [installments, thresholds] = await Promise.all([
    readAllInstallments(db, tx, payment.loanId, loan.pricing?.termInstallments),
    readDelinquencyThresholds(db, tx),
  ]);
  // El recálculo ve el estado final aplicando la transición en memoria (sin re-leer tras
  // escribir): saldo y mora salen de lo que Firestore tendrá guardado.
  const finales = installments.map((cuota) =>
    cuota.installmentNumber === installment.installmentNumber
      ? applyTransition(installment, transition)
      : cuota,
  );
  const recalc = recalcLoanDelinquency(finales, now, thresholds);

  tx.set(db.collection("payments").doc(input.paymentId), stripUndefined(settled));
  tx.update(
    db.collection("loan_installments").doc(payment.installmentId),
    toInstallmentPatch(transition),
  );
  tx.update(db.collection("loans").doc(payment.loanId), loanRecalcPatch(recalc, loan, now));

  tx.set(
    db.collection("payment_events").doc(paymentEventDocId(payment.paymentNumber, 1)),
    stripUndefined(
      buildPaymentEventDoc(
        {
          paymentId: payment.paymentNumber,
          fromStatus: PaymentStatus.PENDING,
          toStatus: PaymentStatus.CONFIRMED,
          actorType: ActorType.ADMIN,
          actorId: input.actor.uid,
          metadata: {
            loanId: payment.loanId,
            installmentId: payment.installmentId,
            amountPesos: payment.amountPesos,
            confirmedBy: settled.confirmedBy,
          },
        },
        now,
      ),
    ),
  );

  auditPayment(db, tx, AuditAction.PAYMENT_CONFIRMED, input.actor, payment, now, {
    fromStatus: PaymentStatus.PENDING,
    toStatus: PaymentStatus.CONFIRMED,
    installmentStatusBefore: installment.status,
    installmentStatusAfter: InstallmentStatus.PAID,
    loanStatusAfter: loanStatusAfterRecalc(recalc, loan.status),
    outstandingPesos: recalc.outstandingPesos,
    idempotencyKey: input.idempotencyKey,
  });
}

async function rejectInTransaction(
  db: Firestore,
  tx: Transaction,
  input: ResolvePaymentInput,
  now: Date,
): Promise<void> {
  const payment = await readPaymentInTx(db, tx, input.paymentId);
  await assertEventSlotFree(db, tx, payment, 1);
  const installment = await readInstallment(db, tx, payment.installmentId);

  const rejected = rejectPaymentState(payment, {
    rejectedBy: input.actor.uid,
    rejectedAt: now,
    reason: input.reason ?? "",
  });
  tx.set(db.collection("payments").doc(input.paymentId), stripUndefined(rejected));

  // Suelta el candado de la cuota: sin esto, una cuota rechazada quedaría bloqueada para siempre.
  const transition = effectRejectInstallment();
  tx.update(db.collection("loan_installments").doc(payment.installmentId), toInstallmentPatch(transition));

  tx.set(
    db.collection("payment_events").doc(paymentEventDocId(payment.paymentNumber, 1)),
    stripUndefined(
      buildPaymentEventDoc(
        {
          paymentId: payment.paymentNumber,
          fromStatus: PaymentStatus.PENDING,
          toStatus: PaymentStatus.REJECTED,
          actorType: ActorType.ADMIN,
          actorId: input.actor.uid,
          reason: rejected.reason,
          metadata: {
            loanId: payment.loanId,
            installmentId: payment.installmentId,
            amountPesos: payment.amountPesos,
          },
        },
        now,
      ),
    ),
  );

  auditPayment(db, tx, AuditAction.PAYMENT_REJECTED, input.actor, payment, now, {
    fromStatus: PaymentStatus.PENDING,
    toStatus: PaymentStatus.REJECTED,
    reason: rejected.reason,
    installmentStatusAfter: installment.status,
    idempotencyKey: input.idempotencyKey,
  });
}

async function reverseInTransaction(
  db: Firestore,
  tx: Transaction,
  input: ResolvePaymentInput,
  now: Date,
): Promise<void> {
  // Lecturas primero, writes después (regla de Firestore).
  const payment = await readPaymentInTx(db, tx, input.paymentId);
  await assertEventSlotFree(db, tx, payment, 2);
  const loan = await readLoan(db, tx, payment.loanId);
  const installment = await readInstallment(db, tx, payment.installmentId);

  const reversed = reversePaymentState(payment, {
    reversedBy: input.actor.uid,
    reversedAt: now,
    reason: input.reason ?? "",
  });
  const transition = effectReverseInstallment(installment, reversed);

  const [installments, thresholds] = await Promise.all([
    readAllInstallments(db, tx, payment.loanId, loan.pricing?.termInstallments),
    readDelinquencyThresholds(db, tx),
  ]);
  const finales = installments.map((cuota) =>
    cuota.installmentNumber === installment.installmentNumber
      ? applyTransition(installment, transition)
      : cuota,
  );
  const recalc = recalcLoanDelinquency(finales, now, thresholds);

  tx.set(db.collection("payments").doc(input.paymentId), stripUndefined(reversed));
  tx.update(
    db.collection("loan_installments").doc(payment.installmentId),
    toInstallmentPatch(transition),
  );
  tx.update(db.collection("loans").doc(payment.loanId), loanRecalcPatch(recalc, loan, now));

  tx.set(
    db.collection("payment_events").doc(paymentEventDocId(payment.paymentNumber, 2)),
    stripUndefined(
      buildPaymentEventDoc(
        {
          paymentId: payment.paymentNumber,
          fromStatus: PaymentStatus.CONFIRMED,
          toStatus: PaymentStatus.REVERSED,
          actorType: ActorType.ADMIN,
          actorId: input.actor.uid,
          reason: reversed.reason,
          metadata: {
            loanId: payment.loanId,
            installmentId: payment.installmentId,
            amountPesos: payment.amountPesos,
            installmentStatusAfter: InstallmentStatus.PENDING,
          },
        },
        now,
      ),
    ),
  );

  auditPayment(db, tx, AuditAction.PAYMENT_REVERSED, input.actor, payment, now, {
    fromStatus: PaymentStatus.CONFIRMED,
    toStatus: PaymentStatus.REVERSED,
    reason: reversed.reason,
    installmentStatusBefore: installment.status,
    installmentStatusAfter: InstallmentStatus.PENDING,
    loanStatusAfter: loanStatusAfterRecalc(recalc, loan.status),
    outstandingPesos: recalc.outstandingPesos,
    idempotencyKey: input.idempotencyKey,
  });
}

async function readAdminResult(
  db: Firestore,
  paymentId: string,
  replayed: boolean,
): Promise<AdminPaymentResult> {
  const paymentSnap = await db.collection("payments").doc(paymentId).get();
  if (!paymentSnap.exists) {
    throw notFound("Pago no encontrado");
  }
  const payment = paymentSnap.data() as PaymentDoc;
  const loanSnap = await db.collection("loans").doc(payment.loanId).get();
  if (!loanSnap.exists) {
    throw notFound("Préstamo no encontrado");
  }
  const loan = loanSnap.data() as LoanDoc;

  return stripUndefined({
    paymentId,
    paymentNumber: payment.paymentNumber,
    userId: payment.userId,
    loanId: payment.loanId,
    installmentId: payment.installmentId,
    amountPesos: payment.amountPesos,
    currency: payment.currency,
    status: payment.status,
    confirmedBy: payment.confirmedBy,
    confirmedAt: payment.confirmedAt === undefined ? undefined : toDate(payment.confirmedAt),
    rejectedBy: payment.rejectedBy,
    rejectedAt: payment.rejectedAt === undefined ? undefined : toDate(payment.rejectedAt),
    reason: payment.reason,
    loan: {
      status: loan.status,
      delinquencyStatus: loan.delinquencyStatus ?? DelinquencyStatus.CURRENT,
      daysPastDue: loan.daysPastDue ?? 0,
      outstandingPesos: loan.outstandingPesos ?? 0,
    },
    replayed,
  }) as unknown as AdminPaymentResult;
}

async function resolvePayment(
  action: "confirm" | "reject" | "reverse",
  deps: PaymentDeps,
  input: ResolvePaymentInput,
): Promise<AdminPaymentResult> {
  assertAdmin(input.actor);
  assertIdempotencyKey(input.idempotencyKey);
  assertPaymentId(input.paymentId);

  const now = new Date();
  let outcome: Awaited<ReturnType<typeof withIdempotency>>;
  try {
    outcome = await withIdempotency(deps.db, {
      scope: `payment.${action}:${input.paymentId}`,
      key: input.idempotencyKey,
      entityType: "payment",
      entityId: input.paymentId,
      ttlMs: IDEMPOTENCY_TTL_MS,
      run: (tx) => {
        const run = { confirm: confirmInTransaction, reject: rejectInTransaction, reverse: reverseInTransaction };
        return run[action](deps.db, tx, input, now);
      },
    });
  } catch (error) {
    toHttp(error);
  }

  if (outcome.entityId === undefined) {
    throw conflict("No se pudo determinar el pago resuelto: repita la operación con una clave nueva");
  }
  return readAdminResult(deps.db, outcome.entityId, outcome.replayed);
}

/** `PENDING → CONFIRMED` por un ADMIN, con recálculo de saldo y mora del préstamo. */
export function confirmPayment(deps: PaymentDeps, input: ResolvePaymentInput): Promise<AdminPaymentResult> {
  return resolvePayment("confirm", deps, input);
}

/** `PENDING → REJECTED`: suelta el candado de la cuota para que se pueda pagar de nuevo. */
export function rejectPayment(deps: PaymentDeps, input: ResolvePaymentInput): Promise<AdminPaymentResult> {
  return resolvePayment("reject", deps, input);
}

/** `CONFIRMED → REVERSED`: revierte la cuota a `PENDING` y recalcula saldo/mora. */
export function reversePayment(deps: PaymentDeps, input: ResolvePaymentInput): Promise<AdminPaymentResult> {
  return resolvePayment("reverse", deps, input);
}
