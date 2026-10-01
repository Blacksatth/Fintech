import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listDelinquencyForAdmin,
  recalcActivePortfolio,
  recalcLoanDelinquencyNow,
} from "../src/services/credit/delinquency-service";
import { createLoanFromApprovedApplication } from "../src/services/credit/loan-service";
import {
  buildCreditProductDoc,
  buildInterestRateDoc,
  buildLoanApplicationDoc,
  buildSystemConfigDoc,
} from "../src/server/credit-doc";
import { stripUndefined } from "../src/server/doc";
import { loanInstallmentDocId } from "../src/server/credit-doc";
import {
  ApplicationStatus,
  DelinquencyStatus,
  LoanStatus,
  Role,
  TermFrequency,
} from "../src/server/types";
import {
  installmentReminderRefKey,
  notificationDocId,
  NotificationType,
} from "../src/server/notification-doc";

/**
 * Cartera de mora contra Firestore real (F11). Lo que los mocks no pueden decir:
 *
 * - que la lectura por igualdad de `status` (sin índice compuesto) encuentra de verdad los
 *   préstamos activos, y que el doc `system_config/delinquency` se lee como espera el servicio;
 * - que el recálculo **escribe** una caché que la siguiente lectura ve, y que al repetirlo no
 *   vuelve a escribir (idempotencia de facto, que es la que sostiene el botón sin
 *   `Idempotency-Key`);
 * - que los avisos salen de verdad a `notifications` con el doc ID determinista y que la segunda
 *   pasada no duplica nada.
 *
 * `recalcActivePortfolio` recorre **toda** la cartera activa del proyecto real: si calcula mal
 * alguna fecha escribe sobre datos ajenos. Por eso el servicio solo toca `loans` que ya estén
 * inconsistentes con sus cuotas, y este archivo limpia todo lo que sembró.
 */

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) throw new Error("FIREBASE_PROJECT_ID requerida. Revisa .env");
if (getApps().length === 0) initializeApp({ projectId });

const db: Firestore = getFirestore();
const ADMIN = { uid: "admin-mora-int", role: Role.ADMIN };
const HOY = new Date("2026-03-24T00:00:00.000Z");

const createdLoans: Array<{ loanId: string; loanNumber: string }> = [];
const createdApplications: string[] = [];
const createdProducts: string[] = [];
const createdUsers: string[] = [];
let createdDelinquencyConfig = false;

/**
 * `recalcActivePortfolio` recorre **toda** la cartera activa del proyecto real, así que además de
 * lo sembrado aquí crea avisos para los préstamos de demostración y una fila de auditoría por
 * pasada. Ninguna de las dos se puede atribuir por loanId, porque el doc de aviso se identifica por
 * su ID determinista y la auditoría es de entidad `portfolio`.
 *
 * Por eso el barrido es por diferencia: se fotoja el conjunto de IDs de `notifications` antes de
 * empezar y al final se borra lo que aparezca de más. Es exacto (no depende de supuestos sobre
 * nombres) y no toca avisos previos, que son datos de la demo.
 */
const avisosPrevios = new Set<string>();
const AUDIT_ACTOR = ADMIN.uid; // uid que solo existe en este test

async function snapshotNotificationIds(): Promise<Set<string>> {
  const snap = await db.collection("notifications").limit(500).get();
  if (snap.size >= 500) {
    throw new Error("La colección notifications tiene 500+ docs: el barrido por diferencia no es seguro aquí");
  }
  return new Set(snap.docs.map((d) => d.id));
}

beforeAll(async () => {
  for (const id of await snapshotNotificationIds()) avisosPrevios.add(id);
});

async function deleteByQuery(collection: string, field: string, value: string): Promise<string[]> {
  const snap = await db.collection(collection).where(field, "==", value).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete().catch(() => undefined)));
  return (await db.collection(collection).where(field, "==", value).get()).docs.map((d) => d.id);
}

async function deleteDoc(collection: string, id: string, failures: string[]): Promise<void> {
  await db
    .collection(collection)
    .doc(id)
    .delete()
    .catch((err: Error) => failures.push(`${collection}/${id}: ${err.message}`));
  if ((await db.collection(collection).doc(id).get()).exists) {
    failures.push(`no se borró ${collection}/${id}`);
  }
}

afterAll(async () => {
  const failures: string[] = [];

  // 1. Avisos creados por este test (los de la cartera de demostración, incluidos).
  for (const id of await snapshotNotificationIds()) {
    if (avisosPrevios.has(id)) continue;
    await deleteDoc("notifications", id, failures);
  }
  // 2. Auditoría de cada pasada de recálculo: el actor es un uid de test.
  for (const id of await deleteByQuery("audit_logs", "actorId", AUDIT_ACTOR)) {
    failures.push(`no se borró audit_logs/${id}`);
  }

  for (const { loanId, loanNumber } of createdLoans) {
    for (const id of await deleteByQuery("loan_installments", "loanId", loanId)) {
      failures.push(`no se borró loan_installments/${id}`);
    }
    await deleteDoc("disbursements", loanId, failures);
    for (const id of await deleteByQuery("audit_logs", "entityId", loanNumber)) {
      failures.push(`no se borró audit_logs/${id}`);
    }
    await deleteDoc("loans", loanId, failures);
  }
  for (const appId of createdApplications) await deleteDoc("loan_applications", appId, failures);
  for (const productCode of createdProducts) {
    for (const id of await deleteByQuery("interest_rates", "productType", productCode)) {
      failures.push(`no se borró interest_rates/${id}`);
    }
    await deleteDoc("credit_products", productCode, failures);
  }
  for (const uid of createdUsers) {
    await deleteDoc("user_profiles", uid, failures);
    await deleteDoc("users", uid, failures);
  }
  // `system_config/delinquency` es configuración compartida: solo se borra si este test la creó.
  if (createdDelinquencyConfig) {
    await deleteDoc("system_config", "delinquency", failures);
  }

  if (failures.length > 0) throw new Error(`limpieza incompleta: ${failures.join("; ")}`);
});

/** El servicio exige umbrales válidos; si el proyecto no tiene el doc, lo crea y lo limpia. */
async function ensureDelinquencyConfig(): Promise<void> {
  const ref = db.collection("system_config").doc("delinquency");
  if ((await ref.get()).exists) return;
  createdDelinquencyConfig = true;
  await ref.set(
    stripUndefined(
      buildSystemConfigDoc({ value: { dueSoonDays: 3, overdueDays: 1, defaultDays: 30 }, updatedBy: "TEST" }, HOY),
    ),
  );
}

async function seedProduct(): Promise<string> {
  const productCode = `MICRO_TEST_MORA${randomUUID().slice(0, 6).toUpperCase()}`;
  createdProducts.push(productCode);
  await db
    .collection("credit_products")
    .doc(productCode)
    .set(
      stripUndefined(
        buildCreditProductDoc(
          {
            name: `Producto mora ${productCode}`,
            currency: "COP",
            termInstallments: 3,
            termFrequency: TermFrequency.MONTHLY,
            effectiveFeeBps: 500,
          },
          HOY,
        ),
      ),
    );
  await db
    .collection("interest_rates")
    .doc(`${productCode}_v1`)
    .set(
      stripUndefined(
        buildInterestRateDoc(
          {
            productType: productCode,
            annualRateBps: 2_400,
            effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
            source: "TEST",
            version: 1,
          },
          HOY,
        ),
      ),
    );
  return productCode;
}

/** Préstamo desembolsado de verdad (servicio de producción) con la primera cuota vencida. */
async function seedOverdueLoan(): Promise<{ loanId: string; loanNumber: string; uid: string; cuota1: number }> {
  await ensureDelinquencyConfig();
  const productCode = await seedProduct();
  const uid = `uid-mora-${randomUUID().slice(0, 8)}`;
  createdUsers.push(uid);
  await db.collection("users").doc(uid).set({
    email: `mora-${uid}@local.dev`,
    fullName: `Titular Mora ${uid}`,
    role: "CUSTOMER",
    createdAt: HOY,
    updatedAt: HOY,
  });
  await db
    .collection("user_profiles")
    .doc(uid)
    .set({ userId: uid, city: "Medellín", occupation: "Docente", createdAt: HOY, updatedAt: HOY });

  const applicationId = `APP-MORA-${randomUUID().slice(0, 8).toUpperCase()}`;
  createdApplications.push(applicationId);
  await db
    .collection("loan_applications")
    .doc(applicationId)
    .set(
      stripUndefined(
        buildLoanApplicationDoc(
          {
            applicationNumber: applicationId,
            userId: uid,
            productId: productCode,
            requestedAmountPesos: 60_000,
            termInstallments: 3,
            termFrequency: TermFrequency.MONTHLY,
            status: ApplicationStatus.APPROVED,
            reviewedBy: ADMIN.uid,
            reviewedAt: HOY,
          },
          HOY,
        ),
      ),
    );

  const loanId = `LOAN-MORA-${randomUUID().slice(0, 8).toUpperCase()}`;
  const loanNumber = `LOAN-MORA-${randomUUID().slice(0, 8).toUpperCase()}`;
  createdLoans.push({ loanId, loanNumber });
  await createLoanFromApprovedApplication(db, {
    applicationId,
    loanId,
    loanNumber,
    now: HOY,
    disbursementDate: HOY,
    actorId: ADMIN.uid,
    actorRole: ADMIN.role,
  });
  await db
    .collection("loans")
    .doc(loanId)
    .update({ status: LoanStatus.DISBURSED, disbursedAt: HOY, updatedAt: HOY });

  // La cuota 1 venció hace 5 días: es la que marca el estado del préstamo.
  const cuotaRef = db.collection("loan_installments").doc(loanInstallmentDocId(loanId, 1));
  const cuota = (await cuotaRef.get()).data() as { totalPesos: number };
  const dueDate = new Date(HOY.getTime() - 5 * 86_400_000);
  await cuotaRef.update({ dueDate, status: "PENDING" });

  return { loanId, loanNumber, uid, cuota1: cuota.totalPesos };
}

describe("cartera de mora (Firestore real)", () => {
  it("lee el préstamo vencido y lo ordena por atraso, con el saldo pendiente", async () => {
    const loan = await seedOverdueLoan();

    const { rows, summary } = await listDelinquencyForAdmin({ db }, { today: HOY });
    const fila = rows.find((row) => row.loanId === loan.loanId);

    expect(fila).toBeDefined();
    expect(fila?.recalc?.delinquencyStatus).toBe(DelinquencyStatus.OVERDUE);
    expect(fila?.recalc?.daysPastDue).toBe(5);
    expect(fila?.nextInstallment?.installmentNumber).toBe(1);
    expect(fila?.nextInstallmentDaysPastDue).toBe(5);
    expect(fila?.holder?.fullName).toContain("Titular Mora");
    // La caché guardada por el alta sigue diciendo "al día": esa es exactamente la mentira que
    // este servicio viene a corregir.
    expect(fila?.cache.delinquencyStatus).not.toBe(DelinquencyStatus.OVERDUE);
    expect(summary.overduePesos).toBeGreaterThanOrEqual(loan.cuota1);
  });

  it("el filtro por estado usa el recálculo, no la caché vieja", async () => {
    const loan = await seedOverdueLoan();

    const { rows } = await listDelinquencyForAdmin(
      { db },
      { filter: { status: DelinquencyStatus.OVERDUE }, today: HOY },
    );

    expect(rows.some((row) => row.loanId === loan.loanId)).toBe(true);
  });

  it("un préstamo sin cuotas aparece con su error y no tumba la cartera", async () => {
    await seedOverdueLoan();
    const loanId = `LOAN-SIN-CUOTAS-${randomUUID().slice(0, 8).toUpperCase()}`;
    createdLoans.push({ loanId, loanNumber: loanId });
    await db.collection("loans").doc(loanId).set({
      loanNumber: loanId,
      userId: `uid-${randomUUID().slice(0, 8)}`,
      status: LoanStatus.DISBURSED,
      createdAt: HOY,
      updatedAt: HOY,
    });

    const { rows } = await listDelinquencyForAdmin({ db }, { today: HOY });
    const fila = rows.find((row) => row.loanId === loanId);

    expect(fila?.recalc).toBeNull();
    expect(fila?.error).toMatch(/no tiene la cuota|no tiene snapshot de pricing/);
  });

  it("el recálculo de un préstamo escribe la caché y la segunda pasada no cambia nada", async () => {
    const loan = await seedOverdueLoan();

    const primera = await recalcLoanDelinquencyNow({ db }, loan.loanId, HOY);
    const segunda = await recalcLoanDelinquencyNow({ db }, loan.loanId, HOY);

    expect(primera.changed).toBe(true);
    expect(segunda.changed).toBe(false);
    const guardado = await db.collection("loans").doc(loan.loanId).get();
    expect(guardado.data()?.["delinquencyStatus"]).toBe(DelinquencyStatus.OVERDUE);
    expect(guardado.data()?.["daysPastDue"]).toBe(5);
  });

  it("el recálculo de la cartera avisa de la cuota vencida y no duplica al repetir", async () => {
    const loan = await seedOverdueLoan();
    const docId = notificationDocId(
      loan.uid,
      NotificationType.INSTALLMENT_OVERDUE,
      installmentReminderRefKey(loan.loanId, 1),
    );

    const primera = await recalcActivePortfolio({ db }, ADMIN, HOY);
    const trasPasar1 = await db.collection("notifications").doc(docId).get();
    const segunda = await recalcActivePortfolio({ db }, ADMIN, HOY);
    const trasPasar2 = await db.collection("notifications").doc(docId).get();

    expect(primera.notificationsCreated).toBeGreaterThanOrEqual(1);
    // La propiedad que sostiene el botón sin `Idempotency-Key`: la segunda pasada no crea nada.
    expect(segunda.notificationsCreated).toBe(0);
    expect(segunda.notificationsSkipped).toBeGreaterThan(0);

    // El aviso se identifica por su doc ID determinista (`refKey` no es campo: §8.1 no lo tiene),
    // y ese ID es justo lo que impide el duplicado: el doc existe y **no se reescribió**.
    expect(trasPasar1.exists).toBe(true);
    expect(trasPasar2.exists).toBe(true);
    expect(trasPasar2.data()?.["createdAt"]?.toMillis()).toBe(trasPasar1.data()?.["createdAt"]?.toMillis());
    expect(trasPasar2.data()?.["type"]).toBe(NotificationType.INSTALLMENT_OVERDUE);
    expect(trasPasar2.data()?.["userId"]).toBe(loan.uid);
    expect(trasPasar2.data()?.["payload"]).toMatchObject({
      loanId: loan.loanId,
      installmentNumber: 1,
      amountPesos: loan.cuota1,
    });

    // Solo por `actorId`: filtrar por `action` también pediría un índice compuesto que este test no
    // puede exigir (y que no está en `firestore.indexes.json`).
    //
    // El recorte a `entityType: "portfolio"` es en memoria y hace falta: el mismo actor de test crea
    // los préstamos del fixture, así que `LOAN_STATUS_CHANGED` (`entityType: "loan"`) comparte
    // `actorId` con estas filas. Afirmar sobre el total mezclaría ambos casos.
    const audit = await db.collection("audit_logs").where("actorId", "==", ADMIN.uid).get();
    const pasadas = audit.docs.filter((d) => d.data()["entityType"] === "portfolio");
    expect(pasadas.length).toBeGreaterThanOrEqual(2);
    expect(pasadas.every((d) => d.data()["action"] === "DELINQUENCY_RECALCULATED")).toBe(true);
  });

  it("un préstamo inexistente da 404", async () => {
    await expect(recalcLoanDelinquencyNow({ db }, `no-existe-${randomUUID()}`, HOY)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
