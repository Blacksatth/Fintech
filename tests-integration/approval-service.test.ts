import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveLoanApplication, rejectLoanApplication } from "../src/services/credit/approval-service";
import { createLoanApplication, submitLoanApplicationService } from "../src/services/credit/loan-application-service";
import { seedCreditConfig } from "../src/services/credit/seed-credit-config";
import { buildUserDoc } from "../src/server/user-doc";
import { ApplicationStatus, Role } from "../src/server/types";
import type { LoanApplicationDoc } from "../src/server/credit-doc";

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID requerida. Revisa .env");
}
if (getApps().length === 0) {
  initializeApp({ projectId });
}

const auth = getAuth();
const db = getFirestore();
const PASSWORD = "approval-int-clave-2026";

const createdUids: string[] = [];
const createdAppIds: string[] = [];
const usedIdempotencyKeys: string[] = [];

/** Cada acción de admin envía su propia clave; un reintento reutiliza la misma. */
function newKey(): string {
  const key = `approval-int-${randomUUID()}`;
  usedIdempotencyKeys.push(key);
  return key;
}

async function createAuthUser(prefix: string, role: Role): Promise<string> {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@local.dev`;
  const user = await auth.createUser({ email, password: PASSWORD });
  createdUids.push(user.uid);
  await db.doc(`users/${user.uid}`).set(buildUserDoc({ email, fullName: "Admin Test", phone: "+573001234567", role }, new Date()));
  return user.uid;
}

async function submitFreshApplication(userId: string, amountPesos: number): Promise<string> {
  const created = await createLoanApplication(
    { db },
    { userId, productId: "MICRO_BASICO", requestedAmountPesos: amountPesos, termInstallments: 4, termFrequency: "MONTHLY" },
  );
  const appId = created.application.applicationNumber;
  createdAppIds.push(appId);
  await submitLoanApplicationService({ db }, appId, userId);
  return appId;
}

async function readApplication(appId: string): Promise<LoanApplicationDoc> {
  const snap = await db.collection("loan_applications").doc(appId).get();
  expect(snap.exists).toBe(true);
  return snap.data() as LoanApplicationDoc;
}

async function readAuditLogs(appId: string): Promise<QueryDocumentSnapshot[]> {
  const snap = await db.collection("audit_logs").where("entityId", "==", appId).get();
  return snap.docs;
}

beforeAll(async () => {
  const productSnap = await db.collection("credit_products").doc("MICRO_BASICO").get();
  if (!productSnap.exists) {
    await seedCreditConfig(db);
  }
});

afterAll(async () => {
  const failures: string[] = [];

  for (const appId of createdAppIds) {
    await db.collection("loan_applications").doc(appId).delete().catch((err: Error) => failures.push(`loan_applications/${appId}: ${err.message}`));
    await db.collection("credit_scores").doc(appId).delete().catch((err: Error) => failures.push(`credit_scores/${appId}: ${err.message}`));
    await db.collection("notifications").doc(`${appId}_approved`).delete().catch(() => {});
    await db.collection("notifications").doc(`${appId}_rejected`).delete().catch(() => {});

    const logs = await db.collection("audit_logs").where("entityId", "==", appId).get();
    for (const log of logs.docs) {
      await log.ref.delete().catch((err: Error) => failures.push(`audit_logs/${log.id}: ${err.message}`));
    }
  }

  for (const uid of createdUids) {
    await db.doc(`users/${uid}`).delete().catch((err: Error) => failures.push(`users/${uid}: ${err.message}`));
    await db.doc(`user_profiles/${uid}`).delete().catch((err: Error) => failures.push(`user_profiles/${uid}: ${err.message}`));
    await auth.deleteUser(uid).catch((err: Error) => failures.push(`auth/${uid}: ${err.message}`));
  }

  for (const key of usedIdempotencyKeys) {
    const keys = await db.collection("idempotency_keys").where("key", "==", key).get();
    for (const doc of keys.docs) {
      await doc.ref.delete().catch((err: Error) => failures.push(`idempotency_keys/${key}: ${err.message}`));
    }
  }

  if (failures.length > 0) throw new Error(`limpieza incompleta: ${failures.join("; ")}`);
});

describe("approval-service (integración Firebase)", () => {
  it("aprueba una solicitud presentada, persiste decisión, auditoría y notificación", async () => {
    const customerUid = await createAuthUser("approval-customer", Role.CUSTOMER);
    const adminUid = await createAuthUser("approval-admin", Role.ADMIN);
    const appId = await submitFreshApplication(customerUid, 50000);

    const result = await approveLoanApplication({ db }, { applicationId: appId, actor: { uid: adminUid, role: Role.ADMIN }, idempotencyKey: newKey() });

    expect(result.application.status).toBe(ApplicationStatus.APPROVED);
    expect(result.application.reviewedBy).toBe(adminUid);
    expect(result.score.score).toBeGreaterThanOrEqual(0);

    const persisted = await readApplication(appId);
    expect(persisted.status).toBe(ApplicationStatus.APPROVED);
    expect(persisted.reviewedBy).toBe(adminUid);
    expect(persisted.decisionNotes).toBe("Aprobada por administrador");

    const logs = await readAuditLogs(appId);
    expect(logs).toHaveLength(1);
    const audit = logs[0].data() as { action: string; actorId: string; entityType: string; metadata: Record<string, unknown> };
    expect(audit.action).toBe("LOAN_APPROVED");
    expect(audit.actorId).toBe(adminUid);
    expect(audit.entityType).toBe("loan_application");
    expect(audit.metadata).toMatchObject({
      fromStatus: ApplicationStatus.SUBMITTED,
      toStatus: ApplicationStatus.APPROVED,
    });

    const notification = await db.collection("notifications").doc(`${appId}_approved`).get();
    expect(notification.exists).toBe(true);
    const notificationData = notification.data() as { userId: string; type: string; status: string };
    expect(notificationData.userId).toBe(customerUid);
    expect(notificationData.type).toBe("LOAN_APPLICATION_APPROVED");
    expect(notificationData.status).toBe("PENDING");
  });

  it("rechaza una solicitud presentada guardando el motivo y notificando", async () => {
    const customerUid = await createAuthUser("approval-customer-rej", Role.CUSTOMER);
    const adminUid = await createAuthUser("approval-admin-rej", Role.ADMIN);
    const appId = await submitFreshApplication(customerUid, 50000);

    const result = await rejectLoanApplication(
      { db },
      { applicationId: appId, actor: { uid: adminUid, role: Role.ADMIN }, idempotencyKey: newKey(), decisionNotes: "  Ingresos insuficientes  " },
    );

    expect(result.application.status).toBe(ApplicationStatus.REJECTED);
    expect(result.application.decisionNotes).toBe("Ingresos insuficientes");

    const persisted = await readApplication(appId);
    expect(persisted.status).toBe(ApplicationStatus.REJECTED);
    expect(persisted.decisionNotes).toBe("Ingresos insuficientes");

    const logs = await readAuditLogs(appId);
    expect(logs).toHaveLength(1);
    expect((logs[0].data() as { action: string }).action).toBe("LOAN_REJECTED");

    const notification = await db.collection("notifications").doc(`${appId}_rejected`).get();
    expect(notification.exists).toBe(true);
    expect((notification.data() as { userId: string }).userId).toBe(customerUid);
  });

  it("rechaza una segunda decisión sobre una solicitud ya aprobada y no la modifica", async () => {
    const customerUid = await createAuthUser("approval-double", Role.CUSTOMER);
    const adminUid = await createAuthUser("approval-double-admin", Role.ADMIN);
    const appId = await submitFreshApplication(customerUid, 50000);

    await approveLoanApplication({ db }, { applicationId: appId, actor: { uid: adminUid, role: Role.ADMIN }, idempotencyKey: newKey() });

    await expect(
      rejectLoanApplication(
        { db },
        { applicationId: appId, actor: { uid: adminUid, role: Role.ADMIN }, idempotencyKey: newKey(), decisionNotes: "Cambio de opinión" },
      ),
    ).rejects.toThrow(`No se puede decidir una solicitud en estado ${ApplicationStatus.APPROVED}`);

    const persisted = await readApplication(appId);
    expect(persisted.status).toBe(ApplicationStatus.APPROVED);
    expect(await readAuditLogs(appId)).toHaveLength(1);
  });

  it("no deja aprobar sin score calculado", async () => {
    const customerUid = await createAuthUser("approval-noscore", Role.CUSTOMER);
    const adminUid = await createAuthUser("approval-noscore-admin", Role.ADMIN);
    const appId = await submitFreshApplication(customerUid, 50000);

    await db.collection("credit_scores").doc(appId).delete();

    await expect(
      approveLoanApplication({ db }, { applicationId: appId, actor: { uid: adminUid, role: Role.ADMIN }, idempotencyKey: newKey() }),
    ).rejects.toThrow("No se puede aprobar una solicitud sin score crediticio calculado");

    const persisted = await readApplication(appId);
    expect(persisted.status).toBe(ApplicationStatus.SUBMITTED);
  });

  it("impide que un actor CUSTOMER decida sobre la solicitud", async () => {
    const customerUid = await createAuthUser("approval-forbidden", Role.CUSTOMER);
    const appId = await submitFreshApplication(customerUid, 50000);

    await expect(
      approveLoanApplication({ db }, { applicationId: appId, actor: { uid: customerUid, role: Role.CUSTOMER }, idempotencyKey: newKey() }),
    ).rejects.toThrow("Solo un administrador puede decidir sobre solicitudes");

    expect((await readApplication(appId)).status).toBe(ApplicationStatus.SUBMITTED);
    expect(await readAuditLogs(appId)).toHaveLength(0);
  });

  it("reproduce la misma decisión con el mismo Idempotency-Key, sin duplicar auditoría", async () => {
    const customerUid = await createAuthUser("approval-replay", Role.CUSTOMER);
    const adminUid = await createAuthUser("approval-replay-admin", Role.ADMIN);
    const appId = await submitFreshApplication(customerUid, 50000);
    const key = newKey();

    const first = await approveLoanApplication(
      { db },
      { applicationId: appId, actor: { uid: adminUid, role: Role.ADMIN }, idempotencyKey: key },
    );
    const second = await approveLoanApplication(
      { db },
      { applicationId: appId, actor: { uid: adminUid, role: Role.ADMIN }, idempotencyKey: key },
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.application.applicationNumber).toBe(first.application.applicationNumber);
    expect(second.application.reviewedBy).toBe(adminUid);
    expect(second.application.reviewedAt.getTime()).toBe(first.application.reviewedAt.getTime());
    expect(second.score).toEqual(first.score);

    // Sin el replay la auditoría crecería; con replay sigue en 1.
    expect(await readAuditLogs(appId)).toHaveLength(1);
  });

  it("con otra clave no re-aplica la decisión sobre una solicitud ya aprobada", async () => {
    const customerUid = await createAuthUser("approval-otherkey", Role.CUSTOMER);
    const adminUid = await createAuthUser("approval-otherkey-admin", Role.ADMIN);
    const appId = await submitFreshApplication(customerUid, 50000);

    await approveLoanApplication(
      { db },
      { applicationId: appId, actor: { uid: adminUid, role: Role.ADMIN }, idempotencyKey: newKey() },
    );

    await expect(
      approveLoanApplication(
        { db },
        { applicationId: appId, actor: { uid: adminUid, role: Role.ADMIN }, idempotencyKey: newKey() },
      ),
    ).rejects.toThrow(`No se puede decidir una solicitud en estado ${ApplicationStatus.APPROVED}`);

    expect((await readApplication(appId)).status).toBe(ApplicationStatus.APPROVED);
    expect(await readAuditLogs(appId)).toHaveLength(1);
  });

  it("exige Idempotency-Key", async () => {
    const customerUid = await createAuthUser("approval-nokey", Role.CUSTOMER);
    const adminUid = await createAuthUser("approval-nokey-admin", Role.ADMIN);
    const appId = await submitFreshApplication(customerUid, 50000);

    await expect(
      approveLoanApplication(
        { db },
        { applicationId: appId, actor: { uid: adminUid, role: Role.ADMIN }, idempotencyKey: "" },
      ),
    ).rejects.toThrow("Falta el encabezado Idempotency-Key");

    expect((await readApplication(appId)).status).toBe(ApplicationStatus.SUBMITTED);
  });

  it("exige motivo al rechazar", async () => {
    const customerUid = await createAuthUser("approval-noreason", Role.CUSTOMER);
    const adminUid = await createAuthUser("approval-noreason-admin", Role.ADMIN);
    const appId = await submitFreshApplication(customerUid, 50000);

    await expect(
      rejectLoanApplication({ db }, { applicationId: appId, actor: { uid: adminUid, role: Role.ADMIN }, idempotencyKey: newKey(), decisionNotes: "   " }),
    ).rejects.toThrow("El motivo de rechazo es obligatorio");

    expect((await readApplication(appId)).status).toBe(ApplicationStatus.SUBMITTED);
  });
});
