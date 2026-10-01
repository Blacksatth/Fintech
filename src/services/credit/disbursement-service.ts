import { type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore";
import {
  AuditAction,
  DelinquencyStatus,
  DisbursementStatus,
  LoanStatus,
  Role,
} from "@/server/types";
import type { DisbursementDoc, LoanDoc, LoanInstallmentDoc } from "@/server/credit-doc";
import { loanInstallmentDocId } from "@/server/credit-doc";
import { badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import { withIdempotency } from "@/lib/idempotency";
import { stripUndefined } from "@/server/doc";
import { add } from "@/server/money";
import {
  ManualDisbursementError,
  manualDisbursementProvider,
  rescheduleDueDates,
} from "@/server/disbursement";

/**
 * Desembolso manual (PROJECT_SPEC §12). El admin referencia la transferencia y la confirma;
 * **nunca** hay confirmación automática, ni siquiera con una referencia ya registrada.
 *
 * La idempotencia usa el patrón de `approval-service`: `idempotency_keys` evita repetir la
 * operación y la respuesta se reconstruye leyendo el doc `disbursements/{loanId}`, que
 * por eso guarda `metadata.rescheduledInstallments`.
 */

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface DisbursementDeps {
  db: Firestore;
}

export interface DisbursementActor {
  uid: string;
  role: string;
}

export interface InitiateDisbursementInput {
  loanId: string;
  actor: DisbursementActor;
  /** `Idempotency-Key` del cliente. Reobligatorio: un inicio nunca se re-aplica. */
  idempotencyKey: string;
  reference?: string;
}

export interface ConfirmDisbursementInput {
  loanId: string;
  actor: DisbursementActor;
  idempotencyKey: string;
  /** Solo si al iniciar todavía no se conocía la referencia. */
  reference?: string;
}

export interface DisbursementResult {
  loanId: string;
  provider: "manual";
  status: DisbursementStatus;
  reference?: string;
  initiatedBy: string;
  initiatedAt: Date;
  confirmedBy?: string;
  confirmedAt?: Date;
  loanStatus: LoanStatus;
  disbursedAt?: Date;
  /** Cuotas reprogramadas al confirmar. `0` en el inicio. */
  rescheduledInstallments: number;
  replayed: boolean;
}

function assertAdmin(actor: DisbursementActor): void {
  if (!actor.uid) {
    throw badRequest("Actor no identificado");
  }
  if (actor.role !== Role.ADMIN) {
    throw forbidden("Solo un administrador puede disbursar un préstamo");
  }
}

function assertIdempotencyKey(key: string | undefined): asserts key is string {
  if (!key || key.trim().length === 0) {
    throw badRequest("Falta el encabezado Idempotency-Key");
  }
}

function scope(action: "initiate" | "confirm", loanId: string): string {
  return `loan.disburse.${action}:${loanId}`;
}

/** Traduce el error de dominio a una respuesta HTTP sin perder su código. */
function toHttp(error: unknown): never {
  if (error instanceof ManualDisbursementError) {
    if (error.statusCode === 400) throw badRequest(error.message);
    if (error.statusCode === 403) throw forbidden(error.message);
    if (error.statusCode === 404) throw notFound(error.message);
    throw conflict(error.message);
  }
  throw error;
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "object" && value !== null && "toMillis" in value) {
    return (value as { toMillis(): number }).toMillis();
  }
  throw new Error("disbursement: fecha esperada no reconocida");
}

function toDate(value: unknown): Date {
  return new Date(toMillis(value));
}

/**
 * Los importes de las cuotas deben seguir cuadrando con los del préstamo **antes** de
 * re-programar fechas. Es la garantía de que el recálculo del calendario no puede mover
 * ni un peso de lo que el cliente ya aceptó.
 */
function assertInstallmentsMatchLoan(loan: LoanDoc, installments: readonly LoanInstallmentDoc[]): void {
  if (installments.length === 0) {
    throw conflict("El préstamo no tiene cuotas: no se puede confirmar el desembolso");
  }
  const sum = (campo: "principalPesos" | "interestPesos" | "feePesos" | "totalPesos") =>
    installments.reduce((acc, cuota) => add(acc, cuota[campo]), 0);
  const comparaciones: [string, number, number][] = [
    ["capital", loan.principalPesos, sum("principalPesos")],
    ["intereses", loan.interestPesos, sum("interestPesos")],
    ["comisiones", loan.feePesos, sum("feePesos")],
    ["total a pagar", loan.totalPayablePesos, sum("totalPesos")],
  ];
  for (const [nombre, esperado, real] of comparaciones) {
    if (esperado !== real) {
      throw conflict(
        `Los ${nombre} de las cuotas (${real}) no coinciden con los del préstamo (${esperado}). ` +
          "No se re-programa el calendario sobre datos inconsistentes",
      );
    }
  }
}

async function readLoan(db: Firestore, tx: Transaction, loanId: string): Promise<LoanDoc> {
  const snap = await tx.get(db.collection("loans").doc(loanId));
  if (!snap.exists) {
    throw notFound("Préstamo no encontrado");
  }
  return snap.data() as LoanDoc;
}

async function readDisbursement(
  db: Firestore,
  tx: Transaction,
  loanId: string,
): Promise<DisbursementDoc | null> {
  const snap = await tx.get(db.collection("disbursements").doc(loanId));
  if (!snap.exists) return null;
  return snap.data() as DisbursementDoc;
}

function assertLoanAwaitingDisbursement(loan: LoanDoc): void {
  if (loan.status !== LoanStatus.PENDING_DISBURSEMENT) {
    throw conflict(
      `El préstamo está en estado ${loan.status}: solo se desembolsa desde ${LoanStatus.PENDING_DISBURSEMENT}`,
    );
  }
}

async function initiateInTransaction(
  db: Firestore,
  tx: Transaction,
  input: InitiateDisbursementInput,
  now: Date,
): Promise<void> {
  const loan = await readLoan(db, tx, input.loanId);
  assertLoanAwaitingDisbursement(loan);
  const current = await readDisbursement(db, tx, input.loanId);

  let doc: DisbursementDoc;
  try {
    doc = manualDisbursementProvider.initiate(current, {
      loanId: input.loanId,
      initiatedBy: input.actor.uid,
      initiatedAt: now,
      idempotencyKey: input.idempotencyKey,
      reference: input.reference,
    });
  } catch (error) {
    toHttp(error);
  }

  // Doc ID = loanId: un doble clic no puede crear dos desembolsos.
  tx.set(db.collection("disbursements").doc(input.loanId), stripUndefined(doc));

  tx.set(db.collection("audit_logs").doc(), {
    actorId: input.actor.uid,
    actorRole: input.actor.role,
    action: AuditAction.LOAN_DISBURSEMENT_INITIATED,
    entityType: "loan",
    entityId: loan.loanNumber,
    metadata: {
      loanId: input.loanId,
      provider: doc.provider,
      disbursementStatus: doc.status,
      reference: doc.reference ?? null,
      idempotencyKey: input.idempotencyKey,
    },
    createdAt: now,
  });
}

/**
 * Las cuotas del préstamo en **un** `getAll`, por id determinista. Evita el query
 * `where(loanId) + orderBy(installmentNumber)`, que exigiría un índice compuesto que hoy no
 * se puede desplegar, y de paso hace imposible reprogramar un número de cuotas distinto del
 * que el préstamo declaró.
 */
async function readInstallments(
  db: Firestore,
  tx: Transaction,
  loanId: string,
  termInstallments: number,
): Promise<LoanInstallmentDoc[]> {
  const refs: DocumentReference[] = Array.from({ length: termInstallments }, (_, i) =>
    db.collection("loan_installments").doc(loanInstallmentDocId(loanId, i + 1)),
  );
  // `getAll` es variádico en el cliente de Node, no acepta el array.
  const snaps = await tx.getAll(...refs);
  const faltante = snaps.find((snap) => !snap.exists);
  if (faltante !== undefined) {
    throw conflict(
      `El préstamo no tiene la cuota ${faltante.id}: no se puede re-programar el calendario sobre datos incompletos`,
    );
  }
  return snaps.map((snap) => snap.data() as LoanInstallmentDoc);
}

async function confirmInTransaction(
  db: Firestore,
  tx: Transaction,
  input: ConfirmDisbursementInput,
  now: Date,
): Promise<void> {
  const loan = await readLoan(db, tx, input.loanId);
  assertLoanAwaitingDisbursement(loan);
  const current = await readDisbursement(db, tx, input.loanId);
  if (current === null) {
    throw notFound("El préstamo no tiene un desembolso iniciado: inicie el desembolso primero");
  }

  let doc: DisbursementDoc;
  try {
    doc = manualDisbursementProvider.confirm(current, {
      reference: input.reference,
      confirmedBy: input.actor.uid,
      confirmedAt: now,
    });
  } catch (error) {
    toHttp(error);
  }

  const { pricing } = loan;
  if (pricing === undefined) {
    throw conflict(
      "El préstamo no tiene snapshot de pricing: no se puede confirmar su desembolso sin re-calcular " +
        "la amortización. Requiere migración de datos",
    );
  }

  // Lectura por id determinista (`${loanId}_${n}`) en un solo `getAll`: sin query, sin índice
  // compuesto, y el número de cuotas sale del snapshot congelado, no de un conteo.
  const installments = await readInstallments(db, tx, input.loanId, pricing.termInstallments);
  assertInstallmentsMatchLoan(loan, installments);

  // Snapshot congelado al aprobar: la tasa vigente no participa del recálculo.
  const reprogramadas = rescheduleDueDates(installments, now, pricing);
  for (const cuota of reprogramadas) {
    // Solo `dueDate`: los importes y el estado de la cuota no se tocan.
    tx.update(
      db.collection("loan_installments").doc(loanInstallmentDocId(input.loanId, cuota.installmentNumber)),
      { dueDate: cuota.dueDate },
    );
  }

  tx.update(db.collection("loans").doc(input.loanId), {
    status: LoanStatus.DISBURSED,
    disbursedAt: now,
    // El calendario acaba de dejar de ser provisional: el préstamo está al día.
    delinquencyStatus: DelinquencyStatus.CURRENT,
    updatedAt: now,
  });

  tx.set(
    db.collection("disbursements").doc(input.loanId),
    stripUndefined({
      ...doc,
      metadata: { rescheduledInstallments: reprogramadas.length },
    }),
  );

  tx.set(db.collection("audit_logs").doc(), {
    actorId: input.actor.uid,
    actorRole: input.actor.role,
    action: AuditAction.LOAN_DISBURSED,
    entityType: "loan",
    entityId: loan.loanNumber,
    metadata: {
      loanId: input.loanId,
      fromStatus: LoanStatus.PENDING_DISBURSEMENT,
      toStatus: LoanStatus.DISBURSED,
      provider: doc.provider,
      reference: doc.reference,
      disbursedAt: now.toISOString(),
      initiatedBy: current.initiatedBy,
      initiatedAt: toDate(current.initiatedAt).toISOString(),
      confirmedBy: doc.confirmedBy,
      rescheduledInstallments: reprogramadas.length,
      principalPesos: loan.principalPesos,
      totalPayablePesos: loan.totalPayablePesos,
      annualRateBps: pricing.annualRateBps,
      rateVersion: pricing.rateVersion,
    },
    createdAt: now,
  });
}

/** Reconstruye la respuesta leyendo la entidad, nunca el registro de idempotencia. */
async function readResult(
  db: Firestore,
  loanId: string,
  replayed: boolean,
): Promise<DisbursementResult> {
  const [loanSnap, disbursementSnap] = await Promise.all([
    db.collection("loans").doc(loanId).get(),
    db.collection("disbursements").doc(loanId).get(),
  ]);
  if (!loanSnap.exists) {
    throw notFound("Préstamo no encontrado");
  }
  if (!disbursementSnap.exists) {
    throw notFound("El préstamo no tiene un desembolso registrado");
  }
  const loan = loanSnap.data() as LoanDoc;
  const doc = disbursementSnap.data() as DisbursementDoc;
  const rescheduled = doc.metadata?.["rescheduledInstallments"];

  return stripUndefined({
    loanId,
    provider: doc.provider,
    status: doc.status,
    reference: doc.reference,
    initiatedBy: doc.initiatedBy,
    initiatedAt: toDate(doc.initiatedAt),
    confirmedBy: doc.confirmedBy,
    confirmedAt: doc.confirmedAt === undefined ? undefined : toDate(doc.confirmedAt),
    loanStatus: loan.status,
    disbursedAt: loan.disbursedAt === undefined ? undefined : toDate(loan.disbursedAt),
    rescheduledInstallments: typeof rescheduled === "number" ? rescheduled : 0,
    replayed,
  }) as unknown as DisbursementResult;
}

export async function initiateLoanDisbursement(
  deps: DisbursementDeps,
  input: InitiateDisbursementInput,
): Promise<DisbursementResult> {
  assertAdmin(input.actor);
  assertIdempotencyKey(input.idempotencyKey);

  const outcome = await withIdempotency(deps.db, {
    scope: scope("initiate", input.loanId),
    key: input.idempotencyKey,
    entityType: "disbursement",
    entityId: input.loanId,
    ttlMs: IDEMPOTENCY_TTL_MS,
    run: (tx) => initiateInTransaction(deps.db, tx, input, new Date()),
  });

  return readResult(deps.db, input.loanId, outcome.replayed);
}

export async function confirmLoanDisbursement(
  deps: DisbursementDeps,
  input: ConfirmDisbursementInput,
): Promise<DisbursementResult> {
  assertAdmin(input.actor);
  assertIdempotencyKey(input.idempotencyKey);

  const outcome = await withIdempotency(deps.db, {
    scope: scope("confirm", input.loanId),
    key: input.idempotencyKey,
    entityType: "disbursement",
    entityId: input.loanId,
    ttlMs: IDEMPOTENCY_TTL_MS,
    run: (tx) => confirmInTransaction(deps.db, tx, input, new Date()),
  });

  return readResult(deps.db, input.loanId, outcome.replayed);
}
