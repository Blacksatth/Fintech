import { type Firestore, type Transaction } from "firebase-admin/firestore";
import { ApplicationStatus, AuditAction, NotificationStatus, Role } from "@/server/types";
import type { CreditScoreDoc, LoanApplicationDoc } from "@/server/credit-doc";
import { badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import { withIdempotency } from "@/lib/idempotency";
import { stripUndefined } from "@/server/doc";

export interface ApprovalDeps {
  db: Firestore;
}

export interface DecisionActor {
  uid: string;
  role: string;
}

export interface ApproveApplicationInput {
  applicationId: string;
  actor: DecisionActor;
  /** `Idempotency-Key` del cliente. Reobligatorio: una decisión nunca se re-aplica. */
  idempotencyKey: string;
  decisionNotes?: string;
}

export interface RejectApplicationInput {
  applicationId: string;
  actor: DecisionActor;
  idempotencyKey: string;
  decisionNotes: string;
}

export interface DecisionApplication {
  id: string;
  applicationNumber: string;
  userId: string;
  productId: string;
  requestedAmountPesos: number;
  termInstallments: number;
  termFrequency: string;
  status: ApplicationStatus;
  decisionNotes?: string;
  reviewedBy: string;
  reviewedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApproveApplicationResult {
  application: DecisionApplication;
  score: { score: number; riskLevel: string; modelVersion: string };
  /** `true` si la respuesta vino del registro de idempotencia y no se re-decidió. */
  replayed: boolean;
}

export interface RejectApplicationResult {
  application: DecisionApplication;
  replayed: boolean;
}

/**
 * Payload que se persiste en `idempotency_keys`: solo valores JSON (fechas en
 * epoch ms) para que un replay sea indistinguible de la respuesta original.
 */
interface DecisionPayload {
  id: string;
  applicationNumber: string;
  userId: string;
  productId: string;
  requestedAmountPesos: number;
  termInstallments: number;
  termFrequency: string;
  status: ApplicationStatus;
  decisionNotes?: string;
  reviewedBy: string;
  reviewedAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  score?: { score: number; riskLevel: string; modelVersion: string };
}

const DECIDABLE_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.SUBMITTED,
  ApplicationStatus.UNDER_REVIEW,
];

const MAX_DECISION_NOTES_LENGTH = 2000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function decisionScope(action: "approve" | "reject", applicationId: string): string {
  return `loan_application.${action}:${applicationId}`;
}

function assertAdmin(actor: DecisionActor): void {
  if (!actor.uid) {
    throw badRequest("Actor no identificado");
  }
  if (actor.role !== Role.ADMIN) {
    throw forbidden("Solo un administrador puede decidir sobre solicitudes");
  }
}

function assertIdempotencyKey(key: string | undefined): asserts key is string {
  if (!key || key.trim().length === 0) {
    throw badRequest("Falta el encabezado Idempotency-Key");
  }
}

function assertDecidable(application: LoanApplicationDoc): void {
  if (!DECIDABLE_STATUSES.includes(application.status)) {
    throw conflict(
      `No se puede decidir una solicitud en estado ${application.status}. Solo se permite desde: ${DECIDABLE_STATUSES.join(", ")}`,
    );
  }
}

function normalizeNotes(notes: string | undefined, fallback: string): string {
  const trimmed = notes?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return fallback;
  }
  if (trimmed.length > MAX_DECISION_NOTES_LENGTH) {
    throw badRequest(`Las notas no pueden superar ${MAX_DECISION_NOTES_LENGTH} caracteres`);
  }
  return trimmed;
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "object" && value !== null && "toMillis" in value) {
    return (value as { toMillis: () => number }).toMillis();
  }
  throw conflict("La solicitud tiene fechas inválidas");
}

function buildNotificationId(applicationId: string, targetStatus: ApplicationStatus): string {
  return `${applicationId}_${targetStatus.toLowerCase()}`;
}

function writeAuditLog(
  db: Firestore,
  tx: Transaction,
  args: {
    actor: DecisionActor;
    action: AuditAction;
    application: LoanApplicationDoc;
    decisionNotes: string;
    now: Date;
    metadata?: Record<string, unknown>;
  },
): void {
  tx.set(
    db.collection("audit_logs").doc(),
    stripUndefined({
      actorId: args.actor.uid,
      actorRole: args.actor.role,
      action: args.action,
      entityType: "loan_application",
      entityId: args.application.applicationNumber,
      metadata: {
        fromStatus: args.application.status,
        toStatus:
          args.action === AuditAction.LOAN_APPROVED
            ? ApplicationStatus.APPROVED
            : ApplicationStatus.REJECTED,
        decisionNotes: args.decisionNotes,
        requestedAmountPesos: args.application.requestedAmountPesos,
        ...args.metadata,
      },
      createdAt: args.now,
    }),
  );
}

function writeNotification(
  db: Firestore,
  tx: Transaction,
  args: {
    application: LoanApplicationDoc;
    targetStatus: ApplicationStatus;
    decisionNotes: string;
    now: Date;
  },
): void {
  const approved = args.targetStatus === ApplicationStatus.APPROVED;
  tx.set(
    db.collection("notifications").doc(buildNotificationId(args.application.applicationNumber, args.targetStatus)),
    stripUndefined({
      userId: args.application.userId,
      type: approved ? "LOAN_APPLICATION_APPROVED" : "LOAN_APPLICATION_REJECTED",
      channel: "IN_APP",
      title: approved ? "Solicitud aprobada" : "Solicitud rechazada",
      body: approved
        ? `Tu solicitud ${args.application.applicationNumber} fue aprobada.`
        : `Tu solicitud ${args.application.applicationNumber} fue rechazada: ${args.decisionNotes}`,
      status: NotificationStatus.PENDING,
      payload: {
        applicationId: args.application.applicationNumber,
        status: args.targetStatus,
        decisionNotes: args.decisionNotes,
      },
      createdAt: args.now,
    }),
  );
}

function toResultApplication(payload: DecisionPayload): DecisionApplication {
  return {
    id: payload.id,
    applicationNumber: payload.applicationNumber,
    userId: payload.userId,
    productId: payload.productId,
    requestedAmountPesos: payload.requestedAmountPesos,
    termInstallments: payload.termInstallments,
    termFrequency: payload.termFrequency,
    status: payload.status,
    decisionNotes: payload.decisionNotes,
    reviewedBy: payload.reviewedBy,
    reviewedAt: new Date(payload.reviewedAtMs),
    createdAt: new Date(payload.createdAtMs),
    updatedAt: new Date(payload.updatedAtMs),
  };
}

/**
 * Aplica la decisión dentro de la transacción de idempotencia: re-lée la solicitud
 * (evita doble decisión concurrente), valida la transición y escribe decisión +
 * auditoría + notificación de forma atómica junto al registro de la clave.
 *
 * Todo lo que puede fallar por estado va aquí adentro y no antes: en un replay
 * `withIdempotency` no ejecuta `run`, así que un reintento con el mismo
 * `Idempotency-Key` devuelve la respuesta original en vez de un 409.
 */
async function decideInTransaction(
  db: Firestore,
  tx: Transaction,
  args: {
    applicationId: string;
    targetStatus: ApplicationStatus;
    actor: DecisionActor;
    decisionNotes: string;
    now: Date;
    auditAction: AuditAction;
    requireScore: boolean;
  },
): Promise<void> {
  const ref = db.collection("loan_applications").doc(args.applicationId);
  const freshSnap = await tx.get(ref);
  if (!freshSnap.exists) {
    throw notFound("Solicitud no encontrada");
  }
  const fresh = freshSnap.data() as LoanApplicationDoc;
  assertDecidable(fresh);

  let score: { score: number; riskLevel: string; modelVersion: string } | undefined;
  if (args.requireScore) {
    const scoreSnap = await tx.get(db.collection("credit_scores").doc(args.applicationId));
    if (!scoreSnap.exists) {
      throw conflict("No se puede aprobar una solicitud sin score crediticio calculado");
    }
    const scoreDoc = scoreSnap.data() as CreditScoreDoc;
    score = { score: scoreDoc.score, riskLevel: scoreDoc.riskLevel, modelVersion: scoreDoc.modelVersion };
  }

  tx.set(
    ref,
    stripUndefined({
      ...fresh,
      status: args.targetStatus,
      decisionNotes: args.decisionNotes,
      reviewedBy: args.actor.uid,
      reviewedAt: args.now,
      updatedAt: args.now,
    }),
  );

  writeAuditLog(db, tx, {
    actor: args.actor,
    action: args.auditAction,
    application: fresh,
    decisionNotes: args.decisionNotes,
    now: args.now,
    metadata: score ? { ...score } : undefined,
  });

  writeNotification(db, tx, {
    application: fresh,
    targetStatus: args.targetStatus,
    decisionNotes: args.decisionNotes,
    now: args.now,
  });
}

/**
 * Reconstruye la respuesta de una decisión leyendo la entidad, no el registro de
 * idempotencia (PROJECT_SPEC §8.1). Es lo que hace que un replay con el mismo
 * `Idempotency-Key` devuelva exactamente lo que está persistido ahora.
 */
type DecisionPayloadWithScore = DecisionPayload & {
  score: NonNullable<DecisionPayload["score"]>;
};

async function readDecisionPayload(
  db: Firestore,
  applicationId: string,
  options: { requireScore: true },
): Promise<DecisionPayloadWithScore>;
async function readDecisionPayload(
  db: Firestore,
  applicationId: string,
  options: { requireScore: false },
): Promise<DecisionPayload>;
async function readDecisionPayload(
  db: Firestore,
  applicationId: string,
  options: { requireScore: boolean },
): Promise<DecisionPayload> {
  const snap = await db.collection("loan_applications").doc(applicationId).get();
  if (!snap.exists) {
    throw notFound("Solicitud no encontrada");
  }
  const application = snap.data() as LoanApplicationDoc;

  let score: DecisionPayload["score"];
  if (options.requireScore) {
    const scoreSnap = await db.collection("credit_scores").doc(applicationId).get();
    if (!scoreSnap.exists) {
      throw conflict("No se puede aprobar una solicitud sin score crediticio calculado");
    }
    const scoreDoc = scoreSnap.data() as CreditScoreDoc;
    score = { score: scoreDoc.score, riskLevel: scoreDoc.riskLevel, modelVersion: scoreDoc.modelVersion };
  }

  return stripUndefined({
    id: applicationId,
    applicationNumber: application.applicationNumber,
    userId: application.userId,
    productId: application.productId,
    requestedAmountPesos: application.requestedAmountPesos,
    termInstallments: application.termInstallments,
    termFrequency: application.termFrequency,
    status: application.status,
    decisionNotes: application.decisionNotes,
    reviewedBy: application.reviewedBy,
    reviewedAtMs: toMillis(application.reviewedAt),
    createdAtMs: toMillis(application.createdAt),
    updatedAtMs: toMillis(application.updatedAt),
    score,
  }) as unknown as DecisionPayload;
}

export async function approveLoanApplication(
  deps: ApprovalDeps,
  input: ApproveApplicationInput,
): Promise<ApproveApplicationResult> {
  const { db } = deps;
  assertAdmin(input.actor);
  assertIdempotencyKey(input.idempotencyKey);

  const now = new Date();
  const decisionNotes = normalizeNotes(input.decisionNotes, "Aprobada por administrador");

  const outcome = await withIdempotency(db, {
    scope: decisionScope("approve", input.applicationId),
    key: input.idempotencyKey,
    entityType: "loan_application",
    entityId: input.applicationId,
    ttlMs: IDEMPOTENCY_TTL_MS,
    run: (tx) =>
      decideInTransaction(db, tx, {
        applicationId: input.applicationId,
        targetStatus: ApplicationStatus.APPROVED,
        actor: input.actor,
        decisionNotes,
        now,
        auditAction: AuditAction.LOAN_APPROVED,
        requireScore: true,
      }),
  });

  const result = await readDecisionPayload(db, input.applicationId, { requireScore: true });

  return { application: toResultApplication(result), score: result.score, replayed: outcome.replayed };
}

export async function rejectLoanApplication(
  deps: ApprovalDeps,
  input: RejectApplicationInput,
): Promise<RejectApplicationResult> {
  const { db } = deps;
  assertAdmin(input.actor);
  assertIdempotencyKey(input.idempotencyKey);

  if (!input.decisionNotes || input.decisionNotes.trim().length === 0) {
    throw badRequest("El motivo de rechazo es obligatorio");
  }
  const decisionNotes = normalizeNotes(input.decisionNotes, "");

  const now = new Date();

  const outcome = await withIdempotency(db, {
    scope: decisionScope("reject", input.applicationId),
    key: input.idempotencyKey,
    entityType: "loan_application",
    entityId: input.applicationId,
    ttlMs: IDEMPOTENCY_TTL_MS,
    run: (tx) =>
      decideInTransaction(db, tx, {
        applicationId: input.applicationId,
        targetStatus: ApplicationStatus.REJECTED,
        actor: input.actor,
        decisionNotes,
        now,
        auditAction: AuditAction.LOAN_REJECTED,
        requireScore: false,
      }),
  });

  const result = await readDecisionPayload(db, input.applicationId, { requireScore: false });
  return { application: toResultApplication(result), replayed: outcome.replayed };
}
