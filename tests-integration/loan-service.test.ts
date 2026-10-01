import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  createLoanFromApprovedApplication,
  getLoanForUser,
  listLoansForUser,
  summarizeLoan,
} from "../src/services/credit/loan-service";
import {
  buildCreditProductDoc,
  buildInterestRateDoc,
  buildLoanApplicationDoc,
} from "../src/server/credit-doc";
import { ApplicationStatus, InstallmentStatus, LoanStatus, TermFrequency } from "../src/server/types";
import { stripUndefined } from "../src/server/doc";
import { addPeriods } from "../src/server/schedule";

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID requerida para tests de integracion. Revisa .env");
}
if (getApps().length === 0) {
  initializeApp({ projectId });
}

const db: Firestore = getFirestore();

const created: Array<{ collection: string; id: string }> = [];
const createdLoans: Array<{ loanId: string; loanNumber: string }> = [];
const createdProducts: string[] = [];

function track(collection: string, id: string): string {
  created.push({ collection, id });
  return id;
}

function trackLoan(loanId: string, loanNumber: string): void {
  track("loans", loanId);
  createdLoans.push({ loanId, loanNumber });
}

async function deleteByQuery(collection: string, field: string, value: string): Promise<void> {
  const snap = await db.collection(collection).where(field, "==", value).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete().catch(() => undefined)));
}

/**
 * El servicio también escribe cuotas y audit logs, que no son derivables de una lista fija
 * de ids: se borran por query sobre el loan. Sin esto la suite deja basura en el proyecto
 * real.
 */
afterEach(async () => {
  for (const { loanId, loanNumber } of createdLoans.splice(0)) {
    await deleteByQuery("loan_installments", "loanId", loanId);
    await deleteByQuery("audit_logs", "entityId", loanNumber);
  }
  for (const productCode of createdProducts.splice(0)) {
    await deleteByQuery("interest_rates", "productType", productCode);
  }
  for (const { collection, id } of created.splice(0)) {
    await db.collection(collection).doc(id).delete().catch(() => undefined);
  }
});

const DISBURSEMENT_DATE = new Date("2026-03-10T00:00:00.000Z");

async function seedProduct(options: { annualRateBps: number; effectiveFeeBps: number }): Promise<string> {
  const productCode = `MICRO_TEST_${randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date();
  await db
    .collection("credit_products")
    .doc(productCode)
    .set(
      stripUndefined(
        buildCreditProductDoc(
          {
            name: `Producto test ${productCode}`,
            currency: "COP",
            termInstallments: 2,
            termFrequency: TermFrequency.MONTHLY,
            effectiveFeeBps: options.effectiveFeeBps,
          },
          now,
        ),
      ),
    );
  track("credit_products", productCode);
  createdProducts.push(productCode);
  await db
    .collection("interest_rates")
    .doc(`${productCode}_v1`)
    .set(
      stripUndefined(
        buildInterestRateDoc(
          {
            productType: productCode,
            annualRateBps: options.annualRateBps,
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

async function seedApprovedApplication(options: {
  userId: string;
  productCode: string;
  status?: ApplicationStatus;
  requestedAmountPesos?: number;
  termInstallments?: number;
  termFrequency?: TermFrequency;
}): Promise<string> {
  const applicationId = track("loan_applications", `APP-TEST-${randomUUID().slice(0, 8).toUpperCase()}`);
  const now = new Date();
  await db
    .collection("loan_applications")
    .doc(applicationId)
    .set(
      stripUndefined(
        buildLoanApplicationDoc(
          {
            applicationNumber: applicationId,
            userId: options.userId,
            productId: options.productCode,
            requestedAmountPesos: options.requestedAmountPesos ?? 50_000,
            termInstallments: options.termInstallments ?? 2,
            termFrequency: options.termFrequency ?? TermFrequency.MONTHLY,
            status: options.status ?? ApplicationStatus.APPROVED,
            reviewedBy: "admin-test",
            reviewedAt: now,
          },
          now,
        ),
      ),
    );
  return applicationId;
}

function loanInput(applicationId: string, now = new Date("2026-03-10T12:00:00.000Z")) {
  return {
    applicationId,
    loanId: `LOAN-TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
    loanNumber: `LOAN-${randomUUID().slice(0, 8).toUpperCase()}`,
    now,
    disbursementDate: DISBURSEMENT_DATE,
    actorId: "admin-test",
    actorRole: "ADMIN",
  };
}

function newUserId(): string {
  return track("users", `uid-${randomUUID().slice(0, 8)}`);
}

describe("createLoanFromApprovedApplication (Firestore real)", () => {
  it("genera el plan desde la tasa vigente y la tarifa del producto", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 2_400, effectiveFeeBps: 500 });
    const applicationId = await seedApprovedApplication({ userId, productCode });
    const input = loanInput(applicationId);
    trackLoan(input.loanId, input.loanNumber);

    const result = await createLoanFromApprovedApplication(db, input);

    expect(result.pricing).toEqual({ annualRateBps: 2_400, effectiveFeeBps: 500, rateVersion: 1 });
    // i = 200bps/periodo. A = 25752 -> saldo 50000, interes 1000, capital 24752
    expect(result.loan.interestPesos).toBe(1_505);
    // 50000 * 500bps / 10000 = 2500
    expect(result.loan.feePesos).toBe(2_500);
    expect(result.loan.totalPayablePesos).toBe(54_005);
    expect(result.loan.outstandingPesos).toBe(54_005);
    expect(result.loan.status).toBe(LoanStatus.PENDING_DISBURSEMENT);
    expect(result.loan.productCode).toBe(productCode);
  });

  it("escribe las cuotas con vencimiento por frecuencia y suma exacta en Firestore", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 2_400, effectiveFeeBps: 500 });
    const applicationId = await seedApprovedApplication({
      userId,
      productCode,
      termInstallments: 3,
      termFrequency: TermFrequency.BIWEEKLY,
    });
    const input = loanInput(applicationId);
    trackLoan(input.loanId, input.loanNumber);

    await createLoanFromApprovedApplication(db, input);

    const snap = await db.collection("loan_installments").where("loanId", "==", input.loanId).get();
    expect(snap.docs).toHaveLength(3);
    const cuotas = snap.docs.map((d) => d.data()).sort((a, b) => a.installmentNumber - b.installmentNumber);

    const sumaPrincipal = cuotas.reduce((acc, c) => acc + c.principalPesos, 0);
    const sumaInterest = cuotas.reduce((acc, c) => acc + c.interestPesos, 0);
    const sumaFee = cuotas.reduce((acc, c) => acc + c.feePesos, 0);
    const sumaTotal = cuotas.reduce((acc, c) => acc + c.totalPesos, 0);
    // 3 periodos biweekly -> 2400/26 = 92bps por periodo.
    // capital creciente 16514 + 16666 + 16820, interes 460 + 308 + 155
    expect(sumaInterest).toBe(923);
    expect(sumaFee).toBe(2_500);
    expect(sumaPrincipal).toBe(50_000);
    expect(sumaTotal).toBe(53_423);

    for (const [i, cuota] of cuotas.entries()) {
      expect(cuota.installmentNumber).toBe(i + 1);
      const esperado = addPeriods(DISBURSEMENT_DATE, TermFrequency.BIWEEKLY, i + 1);
      expect(cuota.dueDate.toMillis()).toBe(esperado.getTime());
      expect(cuota.status).toBe("PENDING");
      expect(cuota.paidPesos).toBe(0);
    }
  });

  it("tasa 0 (arranque PENDING_LEGAL_REVIEW) deja el total en el capital", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });
    const applicationId = await seedApprovedApplication({ userId, productCode });
    const input = loanInput(applicationId);
    trackLoan(input.loanId, input.loanNumber);

    const result = await createLoanFromApprovedApplication(db, input);

    expect(result.loan.interestPesos).toBe(0);
    expect(result.loan.feePesos).toBe(0);
    expect(result.loan.totalPayablePesos).toBe(50_000);
  });

  it("usa la version de tasa mas alta que este vigente", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });
    const now = new Date();
    await db
      .collection("interest_rates")
      .doc(`${productCode}_v2`)
      .set(
        stripUndefined(
          buildInterestRateDoc(
            {
              productType: productCode,
              annualRateBps: 3_600,
              effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
              source: "TEST",
              version: 2,
            },
            now,
          ),
        ),
      );
    const applicationId = await seedApprovedApplication({ userId, productCode });
    const input = loanInput(applicationId);
    trackLoan(input.loanId, input.loanNumber);

    const result = await createLoanFromApprovedApplication(db, input);

    expect(result.pricing.rateVersion).toBe(2);
    // i = 300bps/periodo. A = 26131 -> saldo 50000, interes 1500, capital 24631, saldo 25369
    expect(result.loan.interestPesos).toBe(2_261);
  });

  it("ignora una tasa que todavia no empieza", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 1_200, effectiveFeeBps: 0 });
    const now = new Date();
    await db
      .collection("interest_rates")
      .doc(`${productCode}_v2`)
      .set(
        stripUndefined(
          buildInterestRateDoc(
            {
              productType: productCode,
              annualRateBps: 9_999,
              effectiveFrom: new Date("2027-01-01T00:00:00.000Z"),
              source: "TEST",
              version: 2,
            },
            now,
          ),
        ),
      );
    const applicationId = await seedApprovedApplication({ userId, productCode });
    const input = loanInput(applicationId);
    trackLoan(input.loanId, input.loanNumber);

    const result = await createLoanFromApprovedApplication(db, input);

    expect(result.pricing.rateVersion).toBe(1);
    // i = 100bps/periodo. A = 25376 -> interes 500 + 251
    expect(result.loan.interestPesos).toBe(751);
  });

  it("rechaza una solicitud que no esta APPROVED", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });
    const applicationId = await seedApprovedApplication({
      userId,
      productCode,
      status: ApplicationStatus.SUBMITTED,
    });
    const input = loanInput(applicationId);
    trackLoan(input.loanId, input.loanNumber);

    await expect(createLoanFromApprovedApplication(db, input)).rejects.toThrow(
      "Solo una solicitud APPROVED genera un préstamo",
    );
  });

  it("falla si el producto no tiene tasa vigente", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });
    await deleteByQuery("interest_rates", "productType", productCode);
    const applicationId = await seedApprovedApplication({ userId, productCode });
    const input = loanInput(applicationId);
    trackLoan(input.loanId, input.loanNumber);

    await expect(createLoanFromApprovedApplication(db, input)).rejects.toThrow(
      "No hay tasa de interés activa y vigente",
    );
  });

  it("rechaza una segunda solicitud con préstamo activo del mismo usuario", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });
    const first = loanInput(await seedApprovedApplication({ userId, productCode }));
    trackLoan(first.loanId, first.loanNumber);
    await createLoanFromApprovedApplication(db, first);

    const second = loanInput(await seedApprovedApplication({ userId, productCode }));
    trackLoan(second.loanId, second.loanNumber);

    await expect(createLoanFromApprovedApplication(db, second)).rejects.toThrow(
      "El usuario ya tiene un préstamo activo",
    );
  });

  it("permite un préstamo nuevo cuando el anterior quedó PAID", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });
    const first = loanInput(await seedApprovedApplication({ userId, productCode }));
    trackLoan(first.loanId, first.loanNumber);
    await createLoanFromApprovedApplication(db, first);

    await db.collection("loans").doc(first.loanId).update({ status: LoanStatus.PAID });

    const second = loanInput(await seedApprovedApplication({ userId, productCode }));
    trackLoan(second.loanId, second.loanNumber);
    await expect(createLoanFromApprovedApplication(db, second)).resolves.toBeTruthy();
  });

  it("audita la creación con LOAN_STATUS_CHANGED y la tasa aplicada", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 2_400, effectiveFeeBps: 500 });
    const applicationId = await seedApprovedApplication({ userId, productCode });
    const input = loanInput(applicationId);
    trackLoan(input.loanId, input.loanNumber);

    await createLoanFromApprovedApplication(db, input);

    const auditSnap = await db
      .collection("audit_logs")
      .where("entityId", "==", input.loanNumber)
      .limit(1)
      .get();
    expect(auditSnap.docs).toHaveLength(1);
    const audit = auditSnap.docs[0].data();
    expect(audit.action).toBe("LOAN_STATUS_CHANGED");
    expect(audit.metadata).toMatchObject({
      fromStatus: null,
      toStatus: LoanStatus.PENDING_DISBURSEMENT,
      annualRateBps: 2_400,
      rateVersion: 1,
      installmentCount: 2,
      totalPayablePesos: 54_005,
    });
  });

  it("carrera: dos creaciones concurrentes, solo una pasa (invariante un activo)", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });
    const inputA = loanInput(await seedApprovedApplication({ userId, productCode }));
    const inputB = loanInput(await seedApprovedApplication({ userId, productCode }));
    trackLoan(inputA.loanId, inputA.loanNumber);
    trackLoan(inputB.loanId, inputB.loanNumber);

    // Ventana amplia dentro de la transacción: sin serialización, ambas pasan la
    // comprobación de "préstamos activos" antes de que ninguna escriba.
    const barrier = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    };

    const results = await Promise.allSettled([
      createLoanFromApprovedApplication(db, { ...inputA, onBeforeWrite: barrier }),
      createLoanFromApprovedApplication(db, { ...inputB, onBeforeWrite: barrier }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(reason.message).toContain("El usuario ya tiene un préstamo activo");

    const active = await db
      .collection("loans")
      .where("userId", "==", userId)
      .where("status", "in", [LoanStatus.PENDING_DISBURSEMENT, LoanStatus.DISBURSED, LoanStatus.DEFAULTED])
      .get();
    expect(active.docs).toHaveLength(1);
  });
});

/**
 * F8-3: lecturas que alimentan "Mis préstamos".
 *
 * Estos tests también son la prueba de que las queries elegidas NO necesitan índice
 * compuesto: si lo necesitaran, Firestore real fallaría con FAILED_PRECONDITION y el
 * proyecto no tiene desplegados los índices nuevos.
 */
describe("lectura de prestamos del cliente (Firestore real)", () => {
  it("lista solo los prestamos del usuario y los ordena del mas nuevo al mas viejo", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });

    const primero = loanInput(
      await seedApprovedApplication({ userId, productCode }),
      new Date("2026-01-10T12:00:00.000Z"),
    );
    trackLoan(primero.loanId, primero.loanNumber);
    await createLoanFromApprovedApplication(db, primero);
    await db.collection("loans").doc(primero.loanId).update({ status: LoanStatus.PAID });

    const segundo = loanInput(
      await seedApprovedApplication({ userId, productCode }),
      new Date("2026-05-20T12:00:00.000Z"),
    );
    trackLoan(segundo.loanId, segundo.loanNumber);
    await createLoanFromApprovedApplication(db, segundo);

    // Otro usuario con su propio préstamo: no debe aparecer en la lista.
    const otroUser = newUserId();
    const ajeno = loanInput(await seedApprovedApplication({ userId: otroUser, productCode }));
    trackLoan(ajeno.loanId, ajeno.loanNumber);
    await createLoanFromApprovedApplication(db, ajeno);

    const loans = await listLoansForUser(db, userId);

    expect(loans.map((l) => l.id)).toEqual([segundo.loanId, primero.loanId]);
  });

  it("detalla el prestamo con las cuotas en orden y el proximo vencimiento pendiente", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 2_400, effectiveFeeBps: 500 });
    const input = loanInput(await seedApprovedApplication({ userId, productCode }));
    trackLoan(input.loanId, input.loanNumber);
    await createLoanFromApprovedApplication(db, input);

    const resumen = await summarizeLoan(db, userId, input.loanId);

    expect(resumen.loan.id).toBe(input.loanId);
    expect(resumen.loan.principalPesos).toBe(50_000);
    expect(resumen.installments.map((c) => c.installmentNumber)).toEqual([1, 2]);
    expect(resumen.installmentCount).toBe(2);
    expect(resumen.paidInstallments).toBe(0);
    expect(resumen.outstandingPesos).toBe(54_005);

    const esperada = addPeriods(DISBURSEMENT_DATE, TermFrequency.MONTHLY, 1);
    expect(resumen.nextDueAt?.getTime()).toBe(esperada.getTime());
    expect(resumen.nextInstallmentId).toBe(`${input.loanId}_1`);
  });

  it("el proximo vencimiento salta a la segunda cuota cuando la primera esta pagada", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });
    const input = loanInput(await seedApprovedApplication({ userId, productCode }));
    trackLoan(input.loanId, input.loanNumber);
    await createLoanFromApprovedApplication(db, input);

    await db
      .collection("loan_installments")
      .doc(`${input.loanId}_1`)
      .update({ status: InstallmentStatus.PAID, paidPesos: 25_000, paidAt: new Date() });

    const resumen = await summarizeLoan(db, userId, input.loanId);

    expect(resumen.paidInstallments).toBe(1);
    expect(resumen.nextInstallmentId).toBe(`${input.loanId}_2`);
    expect(resumen.nextDueAt?.getTime()).toBe(
      addPeriods(DISBURSEMENT_DATE, TermFrequency.MONTHLY, 2).getTime(),
    );
  });

  it("no hay proximo vencimiento cuando todas las cuotas estan pagadas", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });
    const input = loanInput(await seedApprovedApplication({ userId, productCode }));
    trackLoan(input.loanId, input.loanNumber);
    await createLoanFromApprovedApplication(db, input);

    const snap = await db.collection("loan_installments").where("loanId", "==", input.loanId).get();
    const batch = db.batch();
    for (const cuota of snap.docs) {
      batch.update(cuota.ref, { status: InstallmentStatus.PAID, paidPesos: cuota.data().totalPesos });
    }
    await batch.commit();

    const resumen = await summarizeLoan(db, userId, input.loanId);

    expect(resumen.paidInstallments).toBe(2);
    expect(resumen.nextDueAt).toBeUndefined();
    expect(resumen.nextInstallmentId).toBeUndefined();
  });

  it("no deja ver el prestamo de otro usuario (404) ni el inexistente (404)", async () => {
    const propietario = newUserId();
    const intruso = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });
    const input = loanInput(await seedApprovedApplication({ userId: propietario, productCode }));
    trackLoan(input.loanId, input.loanNumber);
    await createLoanFromApprovedApplication(db, input);

    await expect(getLoanForUser(db, intruso, input.loanId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getLoanForUser(db, propietario, `LOAN-NO-EXISTE-${randomUUID().slice(0, 6)}`)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(summarizeLoan(db, intruso, input.loanId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("el error de ownership es indistinguible entre ajeno e inexistente", async () => {
    const propietario = newUserId();
    const intruso = newUserId();
    const productCode = await seedProduct({ annualRateBps: 0, effectiveFeeBps: 0 });
    const input = loanInput(await seedApprovedApplication({ userId: propietario, productCode }));
    trackLoan(input.loanId, input.loanNumber);
    await createLoanFromApprovedApplication(db, input);

    const ajeno = await getLoanForUser(db, intruso, input.loanId).catch((e: unknown) => e);
    const inexistente = await getLoanForUser(db, intruso, `LOAN-NO-EXISTE-${randomUUID().slice(0, 6)}`).catch(
      (e: unknown) => e,
    );

    expect((ajeno as Error).message).toBe((inexistente as Error).message);
    expect((ajeno as { statusCode?: number }).statusCode).toBe(
      (inexistente as { statusCode?: number }).statusCode,
    );
  });
});

/**
 * F9 recalculará el calendario al confirmar el desembolso. Para no moverle los pesos al
 * cliente tiene que usar la base de cálculo congelada en el doc, no la tasa vigente.
 */
describe("snapshot de pricing en el prestamo (Firestore real)", () => {
  it("congela la tasa, la tarifa, la version y el plazo que se aplicaron", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 2_400, effectiveFeeBps: 500 });
    const applicationId = await seedApprovedApplication({
      userId,
      productCode,
      termInstallments: 4,
      termFrequency: TermFrequency.BIWEEKLY,
    });
    const input = loanInput(applicationId);
    trackLoan(input.loanId, input.loanNumber);

    await createLoanFromApprovedApplication(db, input);

    const snap = await db.collection("loans").doc(input.loanId).get();
    expect(snap.data()?.pricing).toEqual({
      annualRateBps: 2_400,
      effectiveFeeBps: 500,
      rateVersion: 1,
      termInstallments: 4,
      termFrequency: TermFrequency.BIWEEKLY,
    });
  });

  it("el snapshot NO se actualiza si despues cambia la tasa del producto", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 2_400, effectiveFeeBps: 500 });
    const input = loanInput(await seedApprovedApplication({ userId, productCode }));
    trackLoan(input.loanId, input.loanNumber);
    await createLoanFromApprovedApplication(db, input);

    // Tasa nueva, version superior y vigente: es la que encontraria un recálculo que la
    // consultara en vez de usar el snapshot.
    await db
      .collection("interest_rates")
      .doc(`${productCode}_v2`)
      .set(
        stripUndefined(
          buildInterestRateDoc(
            {
              productType: productCode,
              annualRateBps: 9_999,
              effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
              source: "TEST",
              version: 2,
            },
            new Date(),
          ),
        ),
      );
    track("interest_rates", `${productCode}_v2`);

    const snap = await db.collection("loans").doc(input.loanId).get();
    const pricing = snap.data()?.pricing as { annualRateBps: number; rateVersion: number };

    expect(pricing.annualRateBps).toBe(2_400);
    expect(pricing.rateVersion).toBe(1);
  });

  it("un prestamo viejo sin snapshot es detectable (F9 no debe recalcularlo a ciegas)", async () => {
    const userId = newUserId();
    const productCode = await seedProduct({ annualRateBps: 2_400, effectiveFeeBps: 500 });
    const input = loanInput(await seedApprovedApplication({ userId, productCode }));
    trackLoan(input.loanId, input.loanNumber);
    await createLoanFromApprovedApplication(db, input);

    // Simula un doc escrito antes de que existiera el snapshot.
    const ref = db.collection("loans").doc(input.loanId);
    await ref.update({ pricing: FieldValue.delete() } as Record<string, unknown>);

    const snap = await ref.get();
    expect(snap.data()?.pricing).toBeUndefined();
  });
});
