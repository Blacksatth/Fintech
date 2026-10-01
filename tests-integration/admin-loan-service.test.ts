import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, describe, expect, it } from "vitest";
import {
  getLoanForDisbursement,
  listLoansAwaitingDisbursement,
  listLoansForAdmin,
} from "../src/services/credit/admin-loan-service";
import { createLoanFromApprovedApplication } from "../src/services/credit/loan-service";
import {
  buildCreditProductDoc,
  buildInterestRateDoc,
  buildLoanApplicationDoc,
} from "../src/server/credit-doc";
import { stripUndefined } from "../src/server/doc";
import { ApplicationStatus, LoanStatus, Role, TermFrequency } from "../src/server/types";

/**
 * Lecturas admin de préstamos contra Firestore real. Verifica lo que la UI de F9-2 necesita:
 * la cola de pendientes, el detalle con cuotas/titular/desembolso y que un préstamo legacy sin
 * `pricing` no rompa la pantalla (se muestra el aviso, no un 500).
 */

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) throw new Error("FIREBASE_PROJECT_ID requerida. Revisa .env");
if (getApps().length === 0) initializeApp({ projectId });

const db: Firestore = getFirestore();
const ADMIN = { uid: "admin-loan-read-int", role: Role.ADMIN };
const APROBADO = new Date("2026-03-24T00:00:00.000Z");

const createdLoans: Array<{ loanId: string; loanNumber: string }> = [];
const createdApplications: string[] = [];
const createdProducts: string[] = [];
const createdUsers: string[] = [];

async function deleteByQuery(collection: string, field: string, value: string): Promise<string[]> {
  const snap = await db.collection(collection).where(field, "==", value).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete().catch(() => undefined)));
  const remaining = await db.collection(collection).where(field, "==", value).get();
  return remaining.docs.map((d) => d.id);
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

  if (failures.length > 0) throw new Error(`limpieza incompleta: ${failures.join("; ")}`);
});

async function seedProduct(): Promise<string> {
  const productCode = `MICRO_TEST_READ${randomUUID().slice(0, 6).toUpperCase()}`;
  createdProducts.push(productCode);
  const now = new Date();
  await db
    .collection("credit_products")
    .doc(productCode)
    .set(
      stripUndefined(
        buildCreditProductDoc(
          {
            name: `Producto lectura ${productCode}`,
            currency: "COP",
            termInstallments: 4,
            termFrequency: TermFrequency.BIWEEKLY,
            effectiveFeeBps: 500,
          },
          now,
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
          now,
        ),
      ),
    );
  return productCode;
}

/** Préstamo pendiente de desembolso creado por el servicio de producción, con titular real. */
async function seedPendingLoan(): Promise<{ loanId: string; loanNumber: string; uid: string }> {
  const productCode = await seedProduct();
  const uid = `uid-${randomUUID().slice(0, 8)}`;
  createdUsers.push(uid);
  const now = new Date();
  await db.collection("users").doc(uid).set({
    email: `lectura-${uid}@local.dev`,
    fullName: `Titular Lectura ${uid}`,
    role: "CUSTOMER",
    createdAt: now,
    updatedAt: now,
  });
  await db
    .collection("user_profiles")
    .doc(uid)
    .set({ userId: uid, city: "Medellín", occupation: "Docente", createdAt: now, updatedAt: now });

  const applicationId = `APP-READ-${randomUUID().slice(0, 8).toUpperCase()}`;
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
            requestedAmountPesos: 80_000,
            termInstallments: 4,
            termFrequency: TermFrequency.BIWEEKLY,
            status: ApplicationStatus.APPROVED,
            reviewedBy: ADMIN.uid,
            reviewedAt: now,
          },
          now,
        ),
      ),
    );

  const loanId = `LOAN-READ-${randomUUID().slice(0, 8).toUpperCase()}`;
  const loanNumber = `LOAN-READ-${randomUUID().slice(0, 8).toUpperCase()}`;
  createdLoans.push({ loanId, loanNumber });
  await createLoanFromApprovedApplication(db, {
    applicationId,
    loanId,
    loanNumber,
    now,
    disbursementDate: APROBADO,
    actorId: ADMIN.uid,
    actorRole: ADMIN.role,
  });

  return { loanId, loanNumber, uid };
}

/** Préstamo con la forma anterior a la migración: sin `pricing` y sin cuotas. */
async function seedLegacyLoan(): Promise<string> {
  const now = new Date();
  const loanId = `LOAN-LEGACY-${randomUUID().slice(0, 8).toUpperCase()}`;
  const loanNumber = `LOAN-LEGACY-${randomUUID().slice(0, 8).toUpperCase()}`;
  createdLoans.push({ loanId, loanNumber });
  await db.collection("loans").doc(loanId).set({
    loanNumber,
    applicationId: `APP-LEGACY-${randomUUID().slice(0, 6).toUpperCase()}`,
    userId: `uid-${randomUUID().slice(0, 8)}`,
    principalPesos: 30_000,
    interestPesos: 700,
    feePesos: 1_500,
    totalPayablePesos: 32_200,
    status: LoanStatus.PENDING_DISBURSEMENT,
    createdAt: now,
    updatedAt: now,
  });
  return loanId;
}

/**
 * Documento esqueleto: así son los 41 préstamos que ya había en el proyecto real (solo
 * `userId`, `status`, `createdAt`). La lista admin los muestra y **no puede** reventar al
 * formatear importes inexistentes: fue un 500 real en `/admin/prestamos`.
 */
async function seedSkeletonLoan(): Promise<string> {
  const now = new Date();
  const loanId = `LOAN-SKELETON-${randomUUID().slice(0, 8).toUpperCase()}`;
  createdLoans.push({ loanId, loanNumber: loanId });
  await db
    .collection("loans")
    .doc(loanId)
    .set({ userId: `uid-${randomUUID().slice(0, 8)}`, status: LoanStatus.DISBURSED, createdAt: now });
  return loanId;
}

describe("lecturas admin de préstamos (Firestore real)", () => {
  it("la cola de desembolso incluye el pendiente y ordena por fecha de creación", async () => {
    const loan = await seedPendingLoan();

    const cola = await listLoansAwaitingDisbursement({ db });

    expect(cola.some((l) => l.id === loan.loanId)).toBe(true);
    for (const item of cola) {
      expect(item.status).toBe(LoanStatus.PENDING_DISBURSEMENT);
    }
    const posiciones = cola.map((l) => l.createdAt);
    const tiempos = posiciones.map((d) =>
      d instanceof Date ? d.getTime() : (d as { toMillis(): number }).toMillis(),
    );
    expect([...tiempos].sort((a, b) => b - a)).toEqual(tiempos);
  });

  it("el filtro por estado excluye lo que no corresponde", async () => {
    const loan = await seedPendingLoan();

    const soloPagados = await listLoansForAdmin({ db }, { status: LoanStatus.PAID });

    expect(soloPagados.some((l) => l.id === loan.loanId)).toBe(false);
  });

  it("el detalle trae cuotas en orden, titular y disbursement null", async () => {
    const loan = await seedPendingLoan();

    const review = await getLoanForDisbursement({ db }, loan.loanId);

    expect(review.loan.id).toBe(loan.loanId);
    expect(review.loan.pricing?.termInstallments).toBe(4);
    expect(review.installments).toHaveLength(4);
    expect(review.installments.map((c) => c.installmentNumber)).toEqual([1, 2, 3, 4]);
    expect(review.holder?.email).toBe(`lectura-${loan.uid}@local.dev`);
    expect(review.disbursement).toBeNull();
  });

  it("el detalle refleja un desembolso ya confirmado", async () => {
    const loan = await seedPendingLoan();
    const now = new Date();
    await db
      .collection("disbursements")
      .doc(loan.loanId)
      .set({
        loanId: loan.loanId,
        provider: "manual",
        status: "CONFIRMED",
        reference: "REF-READ-1",
        initiatedBy: ADMIN.uid,
        initiatedAt: now,
        confirmedBy: ADMIN.uid,
        confirmedAt: now,
      });

    const review = await getLoanForDisbursement({ db }, loan.loanId);

    expect(review.disbursement?.status).toBe("CONFIRMED");
    expect(review.disbursement?.reference).toBe("REF-READ-1");
    expect(review.disbursement?.confirmedBy).toBe(ADMIN.uid);
  });

  it("un préstamo legacy sin pricing se lee sin romperse", async () => {
    const loanId = await seedLegacyLoan();

    const review = await getLoanForDisbursement({ db }, loanId);

    expect(review.loan.pricing).toBeUndefined();
    expect(review.installments).toEqual([]);
    expect(review.holder).toBeNull();
  });

  it("un documento esqueleto (sin importes) aparece en la lista sin valores rotos", async () => {
    const loanId = await seedSkeletonLoan();

    const review = await getLoanForDisbursement({ db }, loanId);
    const lista = await listLoansForAdmin({ db }, { status: LoanStatus.DISBURSED });

    expect(review.loan.loanNumber).toBeUndefined();
    expect(review.loan.principalPesos).toBeUndefined();
    expect(review.installments).toEqual([]);
    expect(lista.some((l) => l.id === loanId)).toBe(true);
    // La vista usa el id cuando no hay `loanNumber`, y `formatPesosOrDash` donde no hay importe.
    expect(review.loan.id).toBe(loanId);
  });

  it("un id inexistente da 404, no un error genérico", async () => {
    await expect(getLoanForDisbursement({ db }, `no-existe-${randomUUID()}`)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
