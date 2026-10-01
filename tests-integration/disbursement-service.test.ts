import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { afterAll, describe, expect, it } from "vitest";
import {
  confirmLoanDisbursement,
  initiateLoanDisbursement,
} from "../src/services/credit/disbursement-service";
import { createLoanFromApprovedApplication } from "../src/services/credit/loan-service";
import {
  buildCreditProductDoc,
  buildInterestRateDoc,
  buildLoanApplicationDoc,
} from "../src/server/credit-doc";
import { addPeriods } from "../src/server/schedule";
import { stripUndefined } from "../src/server/doc";
import {
  ApplicationStatus,
  AuditAction,
  InstallmentStatus,
  LoanStatus,
  Role,
  TermFrequency,
} from "../src/server/types";

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID requerida. Revisa .env");
}
if (getApps().length === 0) {
  initializeApp({ projectId });
}

const db: Firestore = getFirestore();
const ADMIN = { uid: "admin-disburse-int", role: Role.ADMIN };
/** Fecha de aprobaciÃ³n: los vencimientos nacen provisionales desde aquÃ­. */
const APROBADO = new Date("2026-03-24T00:00:00.000Z");

const createdLoans: Array<{ loanId: string; loanNumber: string }> = [];
const createdApplications: string[] = [];
const createdProducts: string[] = [];
const usedKeys: string[] = [];

function newKey(prefix: string): string {
  const key = `disburse-int-${prefix}-${randomUUID()}`;
  usedKeys.push(key);
  return key;
}

/**
 * `data()` de Firestore devuelve `Timestamp`, no `Date`. Todos los helpers de este archivo
 * normalizan, para que las aserciones comparen instantes y no tipos.
 */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "object" && value !== null && "toDate" in value) {
    return (value as { toDate(): Date }).toDate();
  }
  throw new Error(`fecha no reconocida: ${String(value)}`);
}

function ms(value: unknown): number {
  return toDate(value).getTime();
}

interface InstallmentData {
  installmentNumber: number;
  dueDate: unknown;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  totalPesos: number;
  paidPesos: number;
  status: string;
}

/**
 * Borra por query y **re-consulta**: el cleanup se autoverifica en vez de asumir que el
 * borrado funcionó. Devuelve los ids que sobrevivieron (debería ser siempre vacío).
 */
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
  const snap = await db.collection(collection).doc(id).get();
  if (snap.exists) {
    failures.push(`no se borro ${collection}/${id}`);
  }
}

/**
 * La limpieza se reparte por **préstamo en paralelo**, no secuencialmente.
 *
 * Con 7 préstamos eran ~56 round trips encadenados contra el proyecto real (delete + re-verificar
 * por query). En aislamiento el hook se acercaba al límite de 30 s, y corriendo los 12 archivos de
 * integración a la vez la latencia lo empujaba fuera y el hook moría con
 * `Hook timed out in 30000ms` — con el proyecto real ya limpio, o sea, un falso positivo que
 * parece un fallo de datos. Dentro de cada préstamo el orden sí importa (cuotas antes que el
 * préstamo), así que solo se paraleliza entre préstamos, que son independientes.
 */
afterAll(async () => {
  const failures: string[] = [];

  await Promise.all(
    createdLoans.map(async ({ loanId, loanNumber }) => {
      for (const id of await deleteByQuery("loan_installments", "loanId", loanId)) {
        failures.push(`no se borro loan_installments/${id}`);
      }
      await deleteDoc("disbursements", loanId, failures);
      for (const id of await deleteByQuery("audit_logs", "entityId", loanNumber)) {
        failures.push(`no se borro audit_logs/${id}`);
      }
      await deleteDoc("loans", loanId, failures);
    }),
  );

  await Promise.all(createdApplications.map((appId) => deleteDoc("loan_applications", appId, failures)));

  await Promise.all(
    createdProducts.map(async (productCode) => {
      for (const id of await deleteByQuery("interest_rates", "productType", productCode)) {
        failures.push(`no se borro interest_rates/${id}`);
      }
      await deleteDoc("credit_products", productCode, failures);
    }),
  );

  await Promise.all(
    usedKeys.map(async (key) => {
      for (const id of await deleteByQuery("idempotency_keys", "key", key)) {
        failures.push(`no se borro idempotency_keys/${id}`);
      }
    }),
  );

  if (failures.length > 0) throw new Error(`limpieza incompleta: ${failures.join("; ")}`);
});

async function seedProduct(annualRateBps: number, effectiveFeeBps: number): Promise<string> {
  const productCode = `MICRO_DISB_${randomUUID().slice(0, 8).toUpperCase()}`;
  createdProducts.push(productCode);
  const now = new Date();
  await db
    .collection("credit_products")
    .doc(productCode)
    .set(
      stripUndefined(
        buildCreditProductDoc(
          {
            name: `Producto desborse test ${productCode}`,
            currency: "COP",
            termInstallments: 4,
            termFrequency: TermFrequency.BIWEEKLY,
            effectiveFeeBps,
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
            annualRateBps,
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

/** PrÃ©stamo real creado por el servicio de producciÃ³n, con su snapshot y sus cuotas. */
async function seedPendingLoan(options: { annualRateBps?: number } = {}): Promise<{
  loanId: string;
  loanNumber: string;
  productCode: string;
  installments: InstallmentData[];
  interestPesos: number;
  totalPayablePesos: number;
}> {
  const productCode = await seedProduct(options.annualRateBps ?? 2_400, 500);
  const applicationId = `APP-DISB-${randomUUID().slice(0, 8).toUpperCase()}`;
  createdApplications.push(applicationId);
  const now = new Date();
  await db
    .collection("loan_applications")
    .doc(applicationId)
    .set(
      stripUndefined(
        buildLoanApplicationDoc(
          {
            applicationNumber: applicationId,
            userId: `uid-${randomUUID().slice(0, 8)}`,
            productId: productCode,
            requestedAmountPesos: 50_000,
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

  const loanId = `LOAN-DISB-${randomUUID().slice(0, 8).toUpperCase()}`;
  const loanNumber = `LOAN-${randomUUID().slice(0, 8).toUpperCase()}`;
  createdLoans.push({ loanId, loanNumber });
  const created = await createLoanFromApprovedApplication(db, {
    applicationId,
    loanId,
    loanNumber,
    now,
    disbursementDate: APROBADO,
    actorId: ADMIN.uid,
    actorRole: ADMIN.role,
  });

  const snap = await db.collection("loan_installments").where("loanId", "==", loanId).get();
  const installments = snap.docs
    .map((d) => d.data() as InstallmentData)
    .sort((a, b) => a.installmentNumber - b.installmentNumber);

  return {
    loanId,
    loanNumber,
    productCode,
    installments,
    interestPesos: created.loan.interestPesos,
    totalPayablePesos: created.loan.totalPayablePesos,
  };
}

async function readInstallments(loanId: string): Promise<InstallmentData[]> {
  const snap = await db.collection("loan_installments").where("loanId", "==", loanId).get();
  return snap.docs
    .map((d) => d.data() as InstallmentData)
    .sort((a, b) => a.installmentNumber - b.installmentNumber);
}

async function auditsFor(entityId: string, action: string): Promise<QueryDocumentSnapshot[]> {
  const snap = await db.collection("audit_logs").where("entityId", "==", entityId).get();
  return snap.docs.filter((d) => d.get("action") === action);
}

describe("desembolso manual (Firestore real)", () => {
  it("flujo completo: iniciar -> confirmar reprograma el calendario y mueve el prestamo", async () => {
    const loan = await seedPendingLoan();
    const provisorias = loan.installments.map((c) => ms(c.dueDate));

    const inicio = await initiateLoanDisbursement(
      { db },
      { loanId: loan.loanId, actor: ADMIN, idempotencyKey: newKey("init"), reference: "REF-INT-1" },
    );

    expect(inicio.status).toBe("INITIATED");
    expect(inicio.loanStatus).toBe(LoanStatus.PENDING_DISBURSEMENT);
    const loanDespuesDelInicio = await db.collection("loans").doc(loan.loanId).get();
    expect(loanDespuesDelInicio.get("status")).toBe(LoanStatus.PENDING_DISBURSEMENT);

    const confirmacion = await confirmLoanDisbursement(
      { db },
      { loanId: loan.loanId, actor: ADMIN, idempotencyKey: newKey("conf") },
    );

    expect(confirmacion.status).toBe("CONFIRMED");
    expect(confirmacion.reference).toBe("REF-INT-1");
    expect(confirmacion.loanStatus).toBe(LoanStatus.DISBURSED);
    expect(confirmacion.rescheduledInstallments).toBe(4);

    const loanDoc = await db.collection("loans").doc(loan.loanId).get();
    const disbursedAt = toDate(loanDoc.get("disbursedAt"));

    // Las fechas se movieron a la fecha real de desembolso, no a la de aprobaciÃ³n.
    expect(loan.installments.map((c) => ms(c.dueDate))).toEqual(provisorias);
    const actuals = await readInstallments(loan.loanId);
    for (const cuota of actuals) {
      expect(ms(cuota.dueDate)).toBeGreaterThan(APROBADO.getTime());
    }
    expect(ms(actuals[0]!.dueDate)).toBe(
      addPeriods(disbursedAt, TermFrequency.BIWEEKLY, 1).getTime(),
    );

    // Y los importes siguen exactamente los que el cliente aceptó al aprobar.
    for (const cuota of actuals) {
      const original = loan.installments.find((c) => c.installmentNumber === cuota.installmentNumber)!;
      expect(cuota.totalPesos).toBe(original.totalPesos);
      expect(cuota.principalPesos).toBe(original.principalPesos);
      expect(cuota.status).toBe(InstallmentStatus.PENDING);
    }

    expect(await auditsFor(loan.loanNumber, AuditAction.LOAN_DISBURSEMENT_INITIATED)).toHaveLength(1);
    const disbursed = await auditsFor(loan.loanNumber, AuditAction.LOAN_DISBURSED);
    expect(disbursed).toHaveLength(1);
    expect(disbursed[0]!.get("metadata")).toMatchObject({
      fromStatus: LoanStatus.PENDING_DISBURSEMENT,
      toStatus: LoanStatus.DISBURSED,
      reference: "REF-INT-1",
      rescheduledInstallments: 4,
    });
  });

  it("replay de la confirmacion no duplica auditoria ni reprograma otra vez", async () => {
    const loan = await seedPendingLoan();
    await initiateLoanDisbursement(
      { db },
      { loanId: loan.loanId, actor: ADMIN, idempotencyKey: newKey("init"), reference: "REF-INT-2" },
    );
    const key = newKey("conf");

    const primero = await confirmLoanDisbursement({ db }, { loanId: loan.loanId, actor: ADMIN, idempotencyKey: key });
    const fechas = (await readInstallments(loan.loanId)).map((c) => ms(c.dueDate));
    const segundo = await confirmLoanDisbursement({ db }, { loanId: loan.loanId, actor: ADMIN, idempotencyKey: key });

    expect(primero.replayed).toBe(false);
    expect(segundo.replayed).toBe(true);
    expect(segundo.rescheduledInstallments).toBe(4);
    expect((await readInstallments(loan.loanId)).map((c) => ms(c.dueDate))).toEqual(fechas);
    expect(await auditsFor(loan.loanNumber, AuditAction.LOAN_DISBURSED)).toHaveLength(1);
  });

  it("replay del inicio no crea un segundo desembolso", async () => {
    const loan = await seedPendingLoan();
    const key = newKey("init");

    await initiateLoanDisbursement({ db }, { loanId: loan.loanId, actor: ADMIN, idempotencyKey: key, reference: "REF-INT-3" });
    const segundo = await initiateLoanDisbursement({ db }, { loanId: loan.loanId, actor: ADMIN, idempotencyKey: key, reference: "REF-INT-3" });

    expect(segundo.replayed).toBe(true);
    const snap = await db.collection("disbursements").where("loanId", "==", loan.loanId).get();
    expect(snap.size).toBe(1);
    expect(await auditsFor(loan.loanNumber, AuditAction.LOAN_DISBURSEMENT_INITIATED)).toHaveLength(1);
  });

  it("no confirma sin referencia: el prestamo sigue pendiente", async () => {
    const loan = await seedPendingLoan();
    await initiateLoanDisbursement(
      { db },
      { loanId: loan.loanId, actor: ADMIN, idempotencyKey: newKey("init") },
    );

    await expect(
      confirmLoanDisbursement({ db }, { loanId: loan.loanId, actor: ADMIN, idempotencyKey: newKey("conf") }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const loanDoc = await db.collection("loans").doc(loan.loanId).get();
    expect(loanDoc.get("status")).toBe(LoanStatus.PENDING_DISBURSEMENT);
    expect(ms((await readInstallments(loan.loanId))[0]!.dueDate)).toBe(
      ms(loan.installments[0]!.dueDate),
    );
  });

  it("una tasa nueva no altera el calendario ya aceptado (usa el snapshot)", async () => {
    const loan = await seedPendingLoan({ annualRateBps: 2_400 });
    // Tasa v2 con fecha futura: es la que estarÃ­a vigente al confirmar si el recalculo la
    // leyera del sistema en vez del snapshot.
    await db
      .collection("interest_rates")
      .doc(`${loan.productCode}_v2`)
      .set(
        stripUndefined(
          buildInterestRateDoc(
            {
              productType: loan.productCode,
              annualRateBps: 9_999,
              effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
              source: "TEST",
              version: 2,
            },
            new Date(),
          ),
        ),
      );

    await initiateLoanDisbursement(
      { db },
      { loanId: loan.loanId, actor: ADMIN, idempotencyKey: newKey("init"), reference: "REF-INT-4" },
    );
    await confirmLoanDisbursement(
      { db },
      { loanId: loan.loanId, actor: ADMIN, idempotencyKey: newKey("conf") },
    );

    const actuals = await readInstallments(loan.loanId);
    for (const cuota of actuals) {
      const original = loan.installments.find((c) => c.installmentNumber === cuota.installmentNumber)!;
      expect(cuota.principalPesos).toBe(original.principalPesos);
      expect(cuota.totalPesos).toBe(original.totalPesos);
    }
    const loanDoc = await db.collection("loans").doc(loan.loanId).get();
    expect(loanDoc.get("totalPayablePesos")).toBe(loan.totalPayablePesos);
    expect(loanDoc.get("interestPesos")).toBe(loan.interestPesos);
    const audit = await auditsFor(loan.loanNumber, AuditAction.LOAN_DISBURSED);
    expect(audit[0]!.get("metadata")).toMatchObject({ annualRateBps: 2_400, rateVersion: 1 });
  });

  it("un prestamo sin snapshot no se desembolsa y no mueve sus vencimientos", async () => {
    const loan = await seedPendingLoan();
    // Simula un prÃ©stamo escrito antes del snapshot de pricing (F9 no puede re-calcularlo).
    await db.collection("loans").doc(loan.loanId).update({ pricing: FieldValue.delete() });
    await initiateLoanDisbursement(
      { db },
      { loanId: loan.loanId, actor: ADMIN, idempotencyKey: newKey("init"), reference: "REF-INT-5" },
    );

    await expect(
      confirmLoanDisbursement({ db }, { loanId: loan.loanId, actor: ADMIN, idempotencyKey: newKey("conf") }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const loanDoc = await db.collection("loans").doc(loan.loanId).get();
    expect(loanDoc.get("status")).toBe(LoanStatus.PENDING_DISBURSEMENT);
    expect(loanDoc.get("disbursedAt")).toBeUndefined();
    expect(ms((await readInstallments(loan.loanId))[0]!.dueDate)).toBe(
      ms(loan.installments[0]!.dueDate),
    );
    expect(await auditsFor(loan.loanNumber, AuditAction.LOAN_DISBURSED)).toHaveLength(0);
  });

  it("un cliente no puede desembolsar", async () => {
    const loan = await seedPendingLoan();

    await expect(
      initiateLoanDisbursement(
        { db },
        {
          loanId: loan.loanId,
          actor: { uid: "cliente", role: Role.CUSTOMER },
          idempotencyKey: newKey("init"),
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
