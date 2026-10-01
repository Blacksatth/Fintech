import { type Firestore, type Transaction } from "firebase-admin/firestore";
import { createLoanApplicationDraft, findEligibleTier, submitLoanApplication, validateApplicationAmount, validateApplicationTerm, ApplicationResult } from "@/server/loan-application";
import { ApplicationStatus, CreditProductDoc, ProductTierDoc, LoanApplicationDoc } from "@/server/credit-doc";
import { TermFrequency } from "@/server/types";
import { termFrequencyLabel } from "@/lib/credit-labels";
import { RuleBasedRiskEngine, createDefaultRiskEngine, RiskContext } from "@/server/risk-engine";
import { calculateAndSaveScore } from "./scoring-service";
import { AuditAction } from "@/server/types";
import { assertOwnedBy } from "@/server/ownership";
import { readActiveCreditLimit } from "@/services/users/user-limit-service";

export interface LoanApplicationDeps {
  db: Firestore;
}

export interface UserLoanHistory {
  completedLoans: number;
  activeLoans: number;
  defaultedLoans: number;
}

async function getProduct(db: Firestore, productId: string): Promise<CreditProductDoc | null> {
  const snap = await db.collection("credit_products").doc(productId).get();
  if (!snap.exists) return null;
  return { ...snap.data(), code: snap.id } as CreditProductDoc & { code: string };
}

async function getActiveTiers(db: Firestore, productCode: string): Promise<ProductTierDoc[]> {
  const snap = await db.collection("product_tiers").where("productCode", "==", productCode).where("isActive", "==", true).get();
  return snap.docs.map((d) => ({ ...d.data(), id: d.id } as ProductTierDoc & { id: string }));
}

async function getUserLoanHistory(db: Firestore, userId: string): Promise<UserLoanHistory> {
  const loansSnap = await db.collection("loans").where("userId", "==", userId).get();
  let completedLoans = 0;
  let activeLoans = 0;
  let defaultedLoans = 0;

  for (const loanDoc of loansSnap.docs) {
    const loan = loanDoc.data();
    if (loan.status === "DISBURSED" || loan.status === "PENDING_DISBURSEMENT") {
      activeLoans++;
    } else if (loan.status === "PAID") {
      completedLoans++;
    } else if (loan.status === "DEFAULTED" || loan.status === "WRITTEN_OFF") {
      defaultedLoans++;
    }
  }

  return { completedLoans, activeLoans, defaultedLoans };
}

async function getApplicationCount(db: Firestore, userId: string): Promise<number> {
  const snap = await db.collection("loan_applications").where("userId", "==", userId).get();
  return snap.size;
}

async function buildRiskContext(
  db: Firestore,
  userId: string,
  application: { userId: string; productId: string; requestedAmountPesos: number; termInstallments: number },
  product: { effectiveFeeBps: number; termInstallments: number; termFrequency: string },
  userHistory: UserLoanHistory,
  applicationCount: number,
): Promise<RiskContext> {
  const incomeRangeSnap = await db.collection("user_profiles").doc(userId).get();
  const incomeRange = incomeRangeSnap.data()?.monthlyIncomeRange;

  // Estimar deuda/ingreso: cuota estimada / ingreso estimado
  // Usamos rangos: "0-1M" -> 500k, "1M-2M" -> 1.5M, etc.
  const incomeMap: Record<string, number> = {
    "0-1M": 500_000,
    "1M-2M": 1_500_000,
    "2M-4M": 3_000_000,
    "4M-8M": 6_000_000,
    "8M+": 10_000_000,
  };
  const estimatedIncome = incomeRange ? incomeMap[incomeRange] ?? 1_500_000 : 1_500_000;

  // Calcular cuota estimada (principal + fee) / termInstallments
  const totalFee = (application.requestedAmountPesos * (application.requestedAmountPesos > 0 ? 0.05 : 0)) / 100; // 5% fee aprox
  const estimatedInstallment = (application.requestedAmountPesos + totalFee) / application.termInstallments;

  const debtToIncomeRatio = estimatedIncome > 0 ? estimatedInstallment / estimatedIncome : 1;

  return {
    userId: application.userId,
    identityVerified: true, // Se asume verificada al crear usuario
    incomeVerifiable: true, // Se asume verificada si hay rango de ingresos
    monthlyIncomeRange: incomeRange,
    debtToIncomeRatio,
    loanHistoryCount: userHistory.completedLoans,
    paymentHistoryScore: userHistory.defaultedLoans > 0 ? 0 : 100, // Simplificado
    previousDelinquency: userHistory.defaultedLoans > 0,
    applicationCount: applicationCount,
  };
}

/**
 * Mayor `applicationNumber` del año, leído **dentro de la transacción** que escribe
 * la nueva solicitud. Leer fuera y escribir después es read-then-write: dos
 * creations simultáneas elegían el mismo número y una sobrescribía a la otra
 * (pérdida de solicitud). Dentro de la transacción, Firestore aborta y reintenta
 * el callback ante el conflicto, así que el segundo creator ve el número ya usado.
 */
async function findHighestApplicationNumber(db: Firestore, t: Transaction, year: number): Promise<number> {
  const prefix = `APP-${year}-`;
  const query = db
    .collection("loan_applications")
    .where("applicationNumber", ">=", prefix)
    .where("applicationNumber", "<", `${prefix}~`)
    .orderBy("applicationNumber", "desc")
    .limit(1);

  const snap = await t.get(query);
  if (snap.empty) return 0;
  const last = snap.docs[0].data().applicationNumber as string | undefined;
  return Number.parseInt(last?.split("-").pop() ?? "0", 10);
}

function formatApplicationNumber(year: number, sequence: number): string {
  return `APP-${year}-${sequence.toString().padStart(4, "0")}`;
}

export async function createLoanApplication(
  deps: LoanApplicationDeps,
  input: { userId: string; productId: string; requestedAmountPesos: number; termInstallments: number; termFrequency: TermFrequency },
): Promise<ApplicationResult> {
  const { db } = deps;
  const now = new Date();

  const product = await getProduct(db, input.productId);
  if (!product || !product.isActive) {
    throw new Error("Producto no encontrado o inactivo");
  }

  const tiers = await getActiveTiers(db, input.productId);
  if (tiers.length === 0) {
    throw new Error("El producto no tiene tiers activos");
  }

  const userHistory = await getUserLoanHistory(db, input.userId);
  const creditLimitPesos = await readActiveCreditLimit(db, input.userId);
  const eligibleResult = findEligibleTier(
    input.userId,
    product,
    tiers,
    userHistory,
    input.productId,
    creditLimitPesos ?? undefined,
  );

  if (!eligibleResult.canApply) {
    throw new Error(eligibleResult.reason ?? "No elegible para solicitar");
  }

  const amountValidation = validateApplicationAmount(input.requestedAmountPesos, eligibleResult.tier);
  if (!amountValidation.valid) {
    throw new Error(amountValidation.reason);
  }

  const termValidation = validateApplicationTerm(product, input.termInstallments, input.termFrequency, termFrequencyLabel);
  if (!termValidation.valid) {
    throw new Error(termValidation.reason);
  }

  const draft = createLoanApplicationDraft(
    { ...input, productId: input.productId } as {
      userId: string;
      productId: string;
      requestedAmountPesos: number;
      termInstallments: number;
      termFrequency: TermFrequency;
    },
    product,
    eligibleResult.tier!,
    now,
  );

  const year = now.getFullYear();
  const applicationNumber = await db.runTransaction(async (t) => {
    const highest = await findHighestApplicationNumber(db, t, year);
    const nextNumber = formatApplicationNumber(year, highest + 1);

    t.set(db.collection("loan_applications").doc(nextNumber), {
      ...draft,
      applicationNumber: nextNumber,
    });

    return nextNumber;
  });

  return { application: { ...draft, applicationNumber }, eligibleTier: eligibleResult };
}

export async function submitLoanApplicationService(
  deps: LoanApplicationDeps,
  applicationId: string,
  userId: string,
): Promise<LoanApplicationDoc> {
  const { db } = deps;
  const now = new Date();

  const appRef = db.collection("loan_applications").doc(applicationId);
  const appSnap = await appRef.get();

  // 404 si no existe o si es de otro usuario (no se revela la existencia de la ajena) y con
  // un AppError, no un Error plano: un Error plano salía como 500.
  const app = assertOwnedBy(
    appSnap.exists ? (appSnap.data() as LoanApplicationDoc) : null,
    userId,
    "Solicitud no encontrada",
  );

  if (app.status !== ApplicationStatus.DRAFT) {
    throw new Error("Solo se puede presentar una solicitud en estado DRAFT");
  }

  // Calcular y guardar el score antes de presentar
  const product = await getProduct(db, app.productId);
  if (product) {
    const userHistory = await getUserLoanHistory(db, app.userId);
    const applicationCount = await getApplicationCount(db, app.userId);

    const riskContext = await buildRiskContext(
      db,
      app.userId,
      app,
      product,
      userHistory,
      applicationCount,
    );

    await calculateAndSaveScore(
      {
        db,
        riskEngine: createDefaultRiskEngine(),
        auditLog: async (action, metadata) => {
          // Aquí se podría integrar con el servicio de auditoría
          console.log(`AUDIT: ${action}`, metadata);
        },
      },
      {
        userId: app.userId,
        applicationId,
        riskContext,
      },
    );
  }

  const submitted = submitLoanApplication(app, now);
  await appRef.set(submitted);

  return submitted;
}

export type LoanApplicationWithId = LoanApplicationDoc & { id: string };

export async function getLoanApplication(
  deps: LoanApplicationDeps,
  applicationId: string,
): Promise<LoanApplicationWithId | null> {
  const snap = await deps.db.collection("loan_applications").doc(applicationId).get();
  if (!snap.exists) return null;
  return { ...snap.data(), id: snap.id } as LoanApplicationWithId;
}

/**
 * Solicitud del propio cliente.
 *
 * 404 tanto si no existe como si es de otro usuario: un 403 revelaría la existencia de la
 * solicitud ajena. Ver `assertOwnedBy`.
 */
export async function getLoanApplicationForUser(
  deps: LoanApplicationDeps,
  userId: string,
  applicationId: string,
): Promise<LoanApplicationWithId> {
  const snap = await deps.db.collection("loan_applications").doc(applicationId).get();
  const application = snap.exists
    ? ({ ...snap.data(), id: snap.id } as LoanApplicationWithId)
    : null;
  return assertOwnedBy(application, userId, "Solicitud no encontrada");
}

export async function listLoanApplications(
  deps: LoanApplicationDeps,
  userId: string,
): Promise<LoanApplicationWithId[]> {
  const snap = await deps.db.collection("loan_applications").where("userId", "==", userId).orderBy("createdAt", "desc").get();
  return snap.docs.map((d) => ({ ...d.data(), id: d.id } as LoanApplicationWithId));
}