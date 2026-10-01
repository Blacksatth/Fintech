import { InstallmentStatus, LoanStatus, PaymentStatus } from "@/server/types";
import type { LoanDoc, LoanInstallmentDoc } from "@/server/credit-doc";
import { loanInstallmentDocId } from "@/server/credit-doc";
import { paymentDocSchema, type PaymentDoc } from "@/server/payment-doc";
import { sub } from "@/server/money";

/**
 * Dominio de pagos (PROJECT_SPEC §11). Puro: sin Firebase ni Next, para que las reglas de
 * dinero sean testeables sin infraestructura.
 *
 * Tres decisiones que el código necesita y la spec no dice, todas documentadas aquí:
 *
 * 1. **El monto lo decide el servidor.** El cliente no envía importe: paga el saldo pendiente
 *    de la cuota (`totalPesos - paidPesos`). Un `amountPesos` manipulado no se ignora en
 *    silencio, no se acepta: la API ni siquiera tiene campo para recibirlo (§11 tabla).
 * 2. **Se puede pagar cualquier cuota pendiente**, no solo la más antigua. El saldo que se
 *    recalcula al confirmar es el de esa cuota, y el dinero existe igual. La UI solo ofrece la
 *    próxima (`GET /api/loans/:id` → `nextInstallmentId`), pero la API no lo impone.
 * 3. **Una cuota no admite dos pagos PENDING.** `pendingPaymentId` es el candado: se escribe
 *    en la misma transacción que crea el pago, así que dos POST simultáneos con claves
 *    distintas se serializan y el segundo recibe 409 en lugar de duplicar un pago que el
 *    admin tendría que rechazar a mano. El candado lo libera la confirmación **y** el
 *    rechazo (F10-2b): confirmado porque la cuota queda pagada, rechazado porque sin ese
 *    borrado la cuota quedaría bloqueada para siempre.
 *
 * La máquina de estados (`PENDING → CONFIRMED | REJECTED`, `CONFIRMED → REVERSED`) vive
 * aquí (F10-2b): las transiciones son funciones puras que validan el estado y devuelven el
 * siguiente doc, con la misma honestidad que `ManualDisbursementProvider`. Un pago solo nace
 * `PENDING` (`buildPaymentDoc`); ningún camino lo confirma solo.
 */

const MAX_REFERENCE_LENGTH = 120;
const MAX_SEQUENCE_PER_YEAR = 9_999;
const MIN_YEAR = 2_000;

export class PaymentError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "PaymentError";
    this.statusCode = statusCode;
  }
}

/**
 * Saldo que falta por pagar de una cuota.
 *
 * `sub` valida enteros seguros: un saldo no entero (piso flotante, centavos) nunca se
 * convierte en un `amountPesos`. Puede salir <= 0 si los datos están corruptos
 * (`paidPesos > totalPesos`); eso lo rechaza `assertPayableInstallment` con un mensaje
 * explícito en vez de propagar un pago negativo.
 */
export function installmentBalance(installment: Pick<LoanInstallmentDoc, "totalPesos" | "paidPesos">): number {
  return sub(installment.totalPesos, installment.paidPesos);
}

/**
 * Consecutivo legible `PAY-2026-0001`, que es también el **doc ID** de `payments`.
 *
 * El ID es el número (y no un `autoId`) por dos razones: el audit log y la UI pueden citar el
 * pago sin una segunda lectura, y dos creaciones simultáneas que elijan el mismo número
 * chocan en la misma ruta del doc, así que Firestore aborta y reintenta la transacción en
 * lugar de sobrescribirse.
 */
export function formatPaymentNumber(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < MIN_YEAR) {
    throw new PaymentError(`Año inválido para numerar un pago: ${String(year)}`, 400);
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE_PER_YEAR) {
    throw new PaymentError(
      `Se agotó la numeración de pagos de ${year}: no se puede registrar el pago ${String(sequence)}`,
    );
  }
  return `PAY-${year}-${sequence.toString().padStart(4, "0")}`;
}

/**
 * Inverso de `formatPaymentNumber` para el año dado. Lanza si el doc guardado no tiene la
 * forma del número: un `paymentNumber` corrupto no sirve para calcular el siguiente, y es
 * mejor fallar que saltarse un número en silencio.
 */
export function parsePaymentNumberSequence(paymentNumber: string, year: number): number {
  const match = new RegExp(`^PAY-${year}-(\\d{4})$`).exec(paymentNumber);
  if (!match) {
    throw new PaymentError(
      `El pago ${paymentNumber} no tiene la forma PAY-${year}-0001: la numeración está corrupta`,
    );
  }
  return Number.parseInt(match[1], 10);
}

/**
 * Referencia que el cliente dice haber usado (número de la transferencia, del Nequi, etc.).
 *
 * Opcional a propósito: el MVP no puede verificar que un canal sin API exista, así que
 * obligarla sería exigir un dato que el cliente quizá no tiene. Vacío = `undefined`, no `""`:
 * el doc no debe llevar campos con strings en blanco.
 */
export function normalizePaymentReference(reference: string | undefined): string | undefined {
  const trimmed = reference?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_REFERENCE_LENGTH) {
    throw new PaymentError(
      `La referencia no puede superar ${MAX_REFERENCE_LENGTH} caracteres`,
      400,
    );
  }
  return trimmed;
}

/**
 * Estados en los que un préstamo puede recibir pagos.
 *
 * `DEFAULTED` sí admite pagos: estar en mora no significa estar saldado, y saldar una mora
 * con un pago es el caso normal del negocio. `PENDING_DISBURSEMENT` no, porque el dinero
 * todavía no salió: un pago de un préstamo que aún no se desembolsó no tiene contra qué
 * saldoarse.
 */
const PAYABLE_LOAN_STATUSES: readonly LoanStatus[] = [LoanStatus.DISBURSED, LoanStatus.DEFAULTED];

export function assertLoanAcceptsPayments(loan: Pick<LoanDoc, "status" | "loanNumber">): void {
  if (PAYABLE_LOAN_STATUSES.includes(loan.status)) return;
  if (loan.status === LoanStatus.PENDING_DISBURSEMENT) {
    throw new PaymentError(
      `El préstamo ${loan.loanNumber} aún no está desembolsado: no hay nada que pagar`,
    );
  }
  if (loan.status === LoanStatus.PAID) {
    throw new PaymentError(`El préstamo ${loan.loanNumber} está saldado`);
  }
  throw new PaymentError(
    `El préstamo ${loan.loanNumber} está en estado ${loan.status}: no admite pagos`,
  );
}

/**
 * Valida la cuota que el cliente dice estar pagando y devuelve **el saldo a pagar**.
 *
 * El valor devuelto es el único importe que puede terminar en `payments.amountPesos`: quien
 * llama no puede elegirlo, solo acceptarlo.
 *
 * 404 (y no 403) cuando la cuota no existe o es de otro préstamo: `installmentId` viene del
 * cuerpo del request y un 403 confirmaría que ese id existe. Es el mismo criterio que
 * `assertOwnedBy` aplica a los préstamos.
 */
export function assertPayableInstallment(
  installment: Pick<LoanInstallmentDoc, "loanId" | "status" | "totalPesos" | "paidPesos" | "pendingPaymentId" | "installmentNumber">,
  target: { loanId: string; installmentId: string },
): number {
  if (installment.loanId !== target.loanId || target.installmentId !== loanInstallmentDocId(target.loanId, installment.installmentNumber)) {
    throw new PaymentError("Cuota no encontrada", 404);
  }
  if (installment.status === InstallmentStatus.PAID) {
    throw new PaymentError("La cuota ya está pagada");
  }
  if (installment.pendingPaymentId !== undefined) {
    throw new PaymentError(
      `La cuota ya tiene el pago ${installment.pendingPaymentId} pendiente de confirmación: ` +
        "espera a que el administrador lo revise",
    );
  }

  const balance = installmentBalance(installment);
  if (balance <= 0) {
    throw new PaymentError(
      `La cuota no tiene saldo pendiente (total ${installment.totalPesos}, pagado ${installment.paidPesos})`,
    );
  }
  return balance;
}

/** ==================== Máquina de estados (F10-2b) ==================== */

const MAX_REASON_LENGTH = 500;

function requireActor(actor: string | undefined, what: string): string {
  const trimmed = actor?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new PaymentError(
      `Falta la identificación del actor: no se puede ${what} sin confirmación humana identificable`,
    );
  }
  return trimmed;
}

function assertDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PaymentError(`${field} inválida`);
  }
  return value;
}

function normalizeReason(reason: string | undefined, what: string): string {
  const trimmed = reason?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new PaymentError(`Falta el motivo: no se puede ${what} sin explicar por qué`, 400);
  }
  if (trimmed.length > MAX_REASON_LENGTH) {
    throw new PaymentError(`El motivo no puede superar ${MAX_REASON_LENGTH} caracteres`, 400);
  }
  return trimmed;
}

function assertPaymentIn(payment: PaymentDoc, allowed: readonly PaymentStatus[], what: string): void {
  if (allowed.includes(payment.status)) return;
  if (payment.status === PaymentStatus.PENDING) {
    throw new PaymentError(`El pago ${payment.paymentNumber} está pendiente: no se puede ${what}`);
  }
  throw new PaymentError(
    `El pago ${payment.paymentNumber} está en estado ${payment.status}: no se puede ${what} desde ahí`,
  );
}

export interface PaymentConfirmation {
  confirmedBy: string;
  confirmedAt: Date;
  /** Nota interna del administrador (opcional). */
  adminNote?: string;
}

export interface PaymentRejection {
  rejectedBy: string;
  rejectedAt: Date;
  reason: string;
}

export interface PaymentReversal {
  reversedBy: string;
  reversedAt: Date;
  reason: string;
}

/**
 * `PENDING → CONFIRMED`. Solo un pago aún pendiente puede confirmarse (la confirmación es
 * humana y no se repite: el estado `CONFIRMED` ya la hace única).
 */
export function confirmPaymentState(payment: PaymentDoc, input: PaymentConfirmation): PaymentDoc {
  assertPaymentIn(payment, [PaymentStatus.PENDING], "confirmar");
  const candidate: PaymentDoc = {
    ...payment,
    status: PaymentStatus.CONFIRMED,
    adminNote: input.adminNote?.trim() || payment.adminNote,
    confirmedBy: requireActor(input.confirmedBy, "confirmar el pago"),
    confirmedAt: assertDate(input.confirmedAt, "confirmedAt"),
    updatedAt: input.confirmedAt,
  };
  return paymentDocSchema.parse(candidate) as PaymentDoc;
}

/**
 * `PENDING → REJECTED`. Requiere motivo y actor: el rechazo devuelve la cuota a `PENDING`
 * disponible (el servicio borra `pendingPaymentId`), así que la única huella del rechazo es
 * este doc, su evento y la auditoría.
 */
export function rejectPaymentState(payment: PaymentDoc, input: PaymentRejection): PaymentDoc {
  assertPaymentIn(payment, [PaymentStatus.PENDING], "rechazar");
  const candidate: PaymentDoc = {
    ...payment,
    status: PaymentStatus.REJECTED,
    rejectedBy: requireActor(input.rejectedBy, "rechazar el pago"),
    rejectedAt: assertDate(input.rejectedAt, "rejectedAt"),
    reason: normalizeReason(input.reason, "rechazar el pago"),
    updatedAt: input.rejectedAt,
  };
  return paymentDocSchema.parse(candidate) as PaymentDoc;
}

/**
 * `CONFIRMED → REVERSED`. El pago reversado conserva `confirmedBy`/`confirmedAt`: son historia
 * (alguien confirmó y luego se deshizo). El actor del reverso va en el `payment_events` y la
 * auditoría (PROJECT_SPEC §8.1: "No hay `reversedBy`").
 */
export function reversePaymentState(payment: PaymentDoc, input: PaymentReversal): PaymentDoc {
  assertPaymentIn(payment, [PaymentStatus.CONFIRMED], "reversar");
  const candidate: PaymentDoc = {
    ...payment,
    status: PaymentStatus.REVERSED,
    reason: normalizeReason(input.reason, "reversar el pago"),
    updatedAt: input.reversedAt,
  };
  return paymentDocSchema.parse(candidate) as PaymentDoc;
}

/**
 * Forma canónica de un número de pago. Es también el doc ID de `payments` y, desde F10-3, un
 * segmento de la ruta del comprobante en el almacenamiento: por eso se valida de forma estricta
 * en la entrada, en vez de fiarse de "no está vacío". Nada de `/`, `..` ni espacios pueden pasar.
 */
export const PAYMENT_NUMBER_PATTERN = /^PAY-\d{4}-\d{4}$/;

/** Valida y devuelve el número de pago, o falla con 400. */
export function assertPaymentNumber(paymentNumber: string): string {
  if (!paymentNumber || !PAYMENT_NUMBER_PATTERN.test(paymentNumber)) {
    throw new PaymentError(`Identificador de pago inválido: ${paymentNumber}`, 400);
  }
  return paymentNumber;
}

/**
 * Solo un pago `PENDING` admite comprobante (F10-3).
 *
 * Razón de ser práctica, no teórica: un pago ya resuelto no vuelve a decidirse, así que un
 * archivo que llegue después no cambiaría nada y solo dejaría evidencia suelta de algo que nadie
 * va a revisar. El comprobante de un pago `REJECTED` o `REVERSED` **se conserva** para
 * diagnóstico: lo que no se admite es añadir uno nuevo.
 */
export function assertPaymentAcceptsReceipt(payment: Pick<PaymentDoc, "paymentNumber" | "status">): void {
  if (payment.status !== PaymentStatus.PENDING) {
    throw new PaymentError(
      `El pago ${payment.paymentNumber} ya no está pendiente: no se le puede adjuntar un comprobante`,
    );
  }
}

/** Campos de cuota que la transición escribe y campos que debe **borrar** (Firestore). */
export interface InstallmentTransition {
  set: Partial<Pick<LoanInstallmentDoc, "paidPesos" | "status" | "paidAt" | "paymentId">>;
  unset: Array<"pendingPaymentId" | "paidAt" | "paymentId">;
}

/**
 * La cuota que un pago va a saldar debe estar literalmente esperándolo: el candado
 * `pendingPaymentId` es de este pago y este pago es de la cuota de su préstamo. Cualquier otra
 * cosa es un pago viejo sobre una cuota que fue a otro lado (rechazada, movida).
 */
export function assertInstallmentLockedByPayment(
  installment: Pick<LoanInstallmentDoc, "loanId" | "pendingPaymentId">,
  payment: Pick<PaymentDoc, "paymentNumber" | "loanId">,
): void {
  if (installment.loanId !== payment.loanId) {
    throw new PaymentError("El pago no pertenece a la cuota que se quiere confirmar", 404);
  }
  if (installment.pendingPaymentId !== payment.paymentNumber) {
    throw new PaymentError(
      `La cuota ya no espera el pago ${payment.paymentNumber}: solo se confirma el pago pendiente actual`,
    );
  }
}

/**
 * Efecto de confirmar sobre la cuota: pasa a `PAID` con `paidPesos` = total.
 *
 * El importe recién se revalida contra el saldo actual: si la cuota se movió desde que se
 * registró el pago, no se confirma un monto que ya no es cierto.
 */
export function effectConfirmInstallment(
  installment: Pick<LoanInstallmentDoc, "loanId" | "status" | "totalPesos" | "paidPesos" | "pendingPaymentId">,
  payment: Pick<PaymentDoc, "paymentNumber" | "loanId" | "amountPesos">,
  now: Date,
): InstallmentTransition {
  assertInstallmentLockedByPayment(installment, payment);
  if (installment.status === InstallmentStatus.PAID) {
    throw new PaymentError("La cuota ya está pagada: no se puede confirmar el pago encima");
  }
  const balance = installmentBalance(installment);
  if (balance !== payment.amountPesos) {
    throw new PaymentError(
      `El saldo de la cuota cambió desde que se registró el pago (era ${payment.amountPesos}, ` +
        `ahora ${balance}): re-evalúe la operación`,
    );
  }
  return {
    set: { paidPesos: installment.totalPesos, status: InstallmentStatus.PAID, paidAt: now, paymentId: payment.paymentNumber },
    unset: ["pendingPaymentId"],
  };
}

/** Efecto de rechazar sobre la cuota: suelta el candado y nada más. */
export function effectRejectInstallment(): InstallmentTransition {
  return { set: {}, unset: ["pendingPaymentId"] };
}

/**
 * Efecto de reversar sobre la cuota: devuelve a `PENDING` lo que el pago saldó y libera
 * `paymentId`/`paidAt`. La cuota vuelve a ser pagable con un pago nuevo.
 *
 * Defensivo, no especulativo: exige que la cuota esté exactamente como la confirmación la dejó
 * (`PAID` por este pago, con `paidPesos >= amountPesos`); si los datos no cuadran es corrupción
 * y se niega en voz alta.
 */
export function effectReverseInstallment(
  installment: Pick<LoanInstallmentDoc, "loanId" | "status" | "paidPesos" | "paymentId">,
  payment: Pick<PaymentDoc, "paymentNumber" | "loanId" | "amountPesos">,
): InstallmentTransition {
  if (installment.loanId !== payment.loanId) {
    throw new PaymentError("El pago no pertenece a la cuota que se quiere reversar", 404);
  }
  if (installment.status !== InstallmentStatus.PAID || installment.paymentId !== payment.paymentNumber) {
    throw new PaymentError(
      `La cuota ya no está pagada por el pago ${payment.paymentNumber}: no se puede reversar`,
    );
  }
  const paid = sub(installment.paidPesos, payment.amountPesos);
  if (paid < 0) {
    throw new PaymentError(
      `El pago ${payment.paymentNumber} (${payment.amountPesos}) excede lo pagado en la cuota ` +
        `(${installment.paidPesos}): datos corruptos, no se reversa`,
    );
  }
  return { set: { paidPesos: paid, status: InstallmentStatus.PENDING }, unset: ["paidAt", "paymentId"] };
}
