import type { Firestore } from "firebase-admin/firestore";
import { UserLimitOverrideDoc, buildUserLimitOverrideDoc } from "@/server/credit-doc";
import { UserDoc } from "@/server/user-doc";
import { assertSafeInteger } from "@/server/money";
import { notFound } from "@/lib/errors";
import { AuditAction, Role } from "@/server/types";

/**
 * Límite de crédito por usuario (PROJECT_SPEC §7.3 y §8, F13-2).
 *
 * Un admin ajusta cuánto puede pedir cada cliente con `user_limit_overrides/{uid}` (un solo
 * documento por usuario, idempotente por id). El `findEligibleTier` del dominio lo aplica como
 * tope al tier elegible; esta capa solo decide qué escribir y deja la traza `LIMIT_CHANGED`.
 *
 * La clave `{uid}` hace la operación idempotente por naturaleza (last-write-wins), así que la ruta
 * no necesita `Idempotency-Key`; la historia completa vive en `audit_logs`.
 */
export interface UserLimitActor {
  uid: string;
  role?: string;
}

export interface SetUserLimitInput {
  userId: string;
  creditLimitPesos: number;
  reason?: string;
}

export interface ClearUserLimitInput {
  userId: string;
  reason?: string;
}

const REASON_SET = "Ajuste manual del límite de crédito";
const REASON_CLEAR = "Límite de crédito removido";

export interface UserWithLimit {
  uid: string;
  user: UserDoc;
  activeLimit: UserLimitOverrideDoc | null;
}

function reasonOrDefault(reason: string | undefined, fallback: string): string {
  const trimmed = reason?.trim();
  if (trimmed) return trimmed;
  return fallback;
}

async function requireExistingUser(db: Firestore, userId: string): Promise<void> {
  const snap = await db.collection("users").doc(userId).get();
  if (!snap.exists) {
    throw notFound(`Usuario ${userId} no encontrado`);
  }
}

/** 404 respeta la a11y de datos: para el admin, un uid inexistente no revela nada por listar. */
export async function listUsersWithLimits(db: Firestore): Promise<UserWithLimit[]> {
  const snap = await db.collection("users").orderBy("createdAt", "desc").get();
  const uids = snap.docs.map((d) => d.id);
  const overrides = await db.getAll(...uids.map((uid) => db.collection("user_limit_overrides").doc(uid)));

  const byUid = new Map<string, UserLimitOverrideDoc | null>();
  overrides.forEach((override) => {
    byUid.set(override.id, override.exists ? (override.data() as UserLimitOverrideDoc) : null);
  });

  return snap.docs.map((doc) => ({
    uid: doc.id,
    user: doc.data() as UserDoc,
    activeLimit: byUid.get(doc.id) ?? null,
  }));
}

/**
 * Límite activo del usuario, o `null` si no tiene override o lo tiene inactivo. Lo consume el
 * flujo de solicitud para topar el tier elegible.
 */
export async function readActiveCreditLimit(db: Firestore, userId: string): Promise<number | null> {
  const snap = await db.collection("user_limit_overrides").doc(userId).get();
  if (!snap.exists) return null;
  const override = snap.data() as UserLimitOverrideDoc;
  if (override.active !== true) return null;
  return assertSafeInteger(override.creditLimitPesos, "creditLimitPesos");
}

export async function setUserCreditLimit(
  db: Firestore,
  actor: UserLimitActor,
  input: SetUserLimitInput,
  now: Date,
): Promise<UserLimitOverrideDoc> {
  const creditLimitPesos = assertSafeInteger(input.creditLimitPesos, "creditLimitPesos");
  if (creditLimitPesos <= 0) {
    throw new RangeError("El límite de crédito debe ser mayor que cero");
  }
  const userId = input.userId.trim();
  if (userId.length === 0) throw new Error("userId vacío");

  await requireExistingUser(db, userId);

  const reason = reasonOrDefault(input.reason, REASON_SET);
  const doc = buildUserLimitOverrideDoc({ userId, creditLimitPesos, overriddenBy: actor.uid, reason, active: true }, now);

  await db.collection("user_limit_overrides").doc(userId).set(doc);
  await db.collection("audit_logs").add({
    actorId: actor.uid,
    actorRole: actor.role ?? Role.ADMIN,
    action: AuditAction.LIMIT_CHANGED,
    entityType: "user",
    entityId: userId,
    metadata: { creditLimitPesos, reason },
    createdAt: now,
  });

  return doc;
}

export async function clearUserCreditLimit(
  db: Firestore,
  actor: UserLimitActor,
  input: ClearUserLimitInput,
  now: Date,
): Promise<void> {
  const userId = input.userId.trim();
  if (userId.length === 0) throw new Error("userId vacío");

  await requireExistingUser(db, userId);

  const ref = db.collection("user_limit_overrides").doc(userId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const previous = snap.data() as UserLimitOverrideDoc;
  const reason = reasonOrDefault(input.reason, REASON_CLEAR);
  const doc = buildUserLimitOverrideDoc(
    {
      userId,
      creditLimitPesos: assertSafeInteger(previous.creditLimitPesos, "creditLimitPesos"),
      overriddenBy: actor.uid,
      reason,
      active: false,
    },
    now,
  );

  await ref.set(doc);
  await db.collection("audit_logs").add({
    actorId: actor.uid,
    actorRole: actor.role ?? Role.ADMIN,
    action: AuditAction.LIMIT_CHANGED,
    entityType: "user",
    entityId: userId,
    metadata: { creditLimitPesos: null, reason },
    createdAt: now,
  });
}