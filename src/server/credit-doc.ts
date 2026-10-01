import { z } from "zod";
import {
  ApplicationStatus,
  DelinquencyStatus,
  DisbursementStatus,
  InstallmentStatus,
  LoanStatus,
  TermFrequency,
} from "./types";
import { add, assertSafeInteger } from "./money";

/**
 * Documentos de crédito (PROJECT_SPEC §8.1).
 *
 * Dominio puro: sin imports de Next/Firebase. La contraseña nunca vive aquí.
 */

export { TermFrequency, ApplicationStatus } from "./types";
export { LoanStatus, InstallmentStatus, DelinquencyStatus } from "./types";

export const Currency = {
  COP: "COP",
} as const;
export type Currency = (typeof Currency)[keyof typeof Currency];

/** Fecha en dominio; Timestamp de Firestore al leer. */
export type CreditDocDate = Date | { toMillis: () => number };

/**
 * Acepta `Date` (dominio) o `Timestamp` (lo que devuelve Firestore al leer). Exportado para que
 * los dominios hermanos (`payment-doc.ts`) no reimplementen la unión.
 */
export const creditDocDateSchema = z.union([
  z.date(),
  z.custom<CreditDocDate>((v): v is CreditDocDate => typeof (v as { toMillis?: unknown }).toMillis === "function"),
]);

const creditDocDateOptional = creditDocDateSchema.optional();

/** ==================== credit_products ==================== */

export interface CreditProductDoc {
  name: string;
  currency: Currency;
  /** Plazo por defecto que el formulario ofrece al cliente (no es fijo). */
  termInstallments: number;
  /** Frecuencia única del producto: el cliente elige cuántas cuotas, no la periodicidad. */
  termFrequency: TermFrequency;
  /** Rango de cuotas permitido (mínimo 2): el cliente elige en `[min, max]`. */
  minTermInstallments: number;
  maxTermInstallments: number;
  effectiveFeeBps: number;
  isActive: boolean;
  createdAt: CreditDocDate;
  updatedAt: CreditDocDate;
}

export interface BuildCreditProductInput {
  name: string;
  currency: Currency;
  termInstallments: number;
  termFrequency: TermFrequency;
  effectiveFeeBps: number;
  minTermInstallments?: number;
  maxTermInstallments?: number;
  isActive?: boolean;
}

const termInstallments = z.number().int().positive();
const minTermInstallments = z.number().int().min(2);
const maxTermInstallments = z.number().int().min(2);
const feeBps = z.number().int().min(0).max(10000);
const isActive = z.boolean().default(true);

export const creditProductDocSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    currency: z.enum([Currency.COP]),
    termInstallments,
    termFrequency: z.enum([TermFrequency.WEEKLY, TermFrequency.BIWEEKLY, TermFrequency.MONTHLY]),
    minTermInstallments,
    maxTermInstallments,
    effectiveFeeBps: feeBps,
    isActive,
    createdAt: creditDocDateSchema,
    updatedAt: creditDocDateSchema,
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.maxTermInstallments < d.minTermInstallments) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxTermInstallments"],
        message: "maxTermInstallments no puede ser menor que minTermInstallments",
      });
    }
    if (d.termInstallments < d.minTermInstallments || d.termInstallments > d.maxTermInstallments) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["termInstallments"],
        message: "termInstallments debe estar entre minTermInstallments y maxTermInstallments",
      });
    }
  });

/** Defaults de producto para docs legados que aún no declaran rango de plazo. */
export const DEFAULT_PRODUCT_TERM_RANGE = { min: 2, max: 6 } as const;

export function buildCreditProductDoc(input: BuildCreditProductInput, now: Date): CreditProductDoc {
  const candidate: CreditProductDoc = {
    name: input.name,
    currency: input.currency,
    termInstallments: input.termInstallments,
    termFrequency: input.termFrequency,
    minTermInstallments: input.minTermInstallments ?? DEFAULT_PRODUCT_TERM_RANGE.min,
    maxTermInstallments: input.maxTermInstallments ?? DEFAULT_PRODUCT_TERM_RANGE.max,
    effectiveFeeBps: input.effectiveFeeBps,
    isActive: input.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };
  return creditProductDocSchema.parse(candidate) as CreditProductDoc;
}

/** ==================== product_tiers ==================== */

export interface ProductTierDoc {
  productCode: string;
  position: number;
  amountPesos: number;
  minScore?: number;
  isActive: boolean;
  createdAt: CreditDocDate;
  updatedAt: CreditDocDate;
}

export interface BuildProductTierInput {
  productCode: string;
  position: number;
  amountPesos: number;
  minScore?: number;
  isActive?: boolean;
}

export const productTierDocSchema = z
  .object({
    productCode: z.string().trim().min(1).max(50),
    position: z.number().int().positive(),
    amountPesos: z.number().int().positive(),
    minScore: z.number().int().min(0).max(100).optional(),
    isActive: z.boolean().default(true),
    createdAt: creditDocDateSchema,
    updatedAt: creditDocDateSchema,
  })
  .strict();

export function buildProductTierDoc(input: BuildProductTierInput, now: Date): ProductTierDoc {
  const candidate: ProductTierDoc = {
    productCode: input.productCode,
    position: input.position,
    amountPesos: input.amountPesos,
    minScore: input.minScore,
    isActive: input.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };
  return productTierDocSchema.parse(candidate) as ProductTierDoc;
}

/** ==================== user_limit_overrides ==================== */

export interface UserLimitOverrideDoc {
  userId: string;
  creditLimitPesos: number;
  overriddenBy: string;
  reason: string;
  active: boolean;
  createdAt: CreditDocDate;
}

export interface BuildUserLimitOverrideInput {
  userId: string;
  creditLimitPesos: number;
  overriddenBy: string;
  reason: string;
  active?: boolean;
}

export const userLimitOverrideDocSchema = z
  .object({
    userId: z.string().trim().min(1),
    creditLimitPesos: z.number().int().positive(),
    overriddenBy: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(500),
    active: z.boolean().default(true),
    createdAt: creditDocDateSchema,
  })
  .strict();

export function buildUserLimitOverrideDoc(input: BuildUserLimitOverrideInput, now: Date): UserLimitOverrideDoc {
  const candidate: UserLimitOverrideDoc = {
    userId: input.userId,
    creditLimitPesos: input.creditLimitPesos,
    overriddenBy: input.overriddenBy,
    reason: input.reason,
    active: input.active ?? true,
    createdAt: now,
  };
  return userLimitOverrideDocSchema.parse(candidate) as UserLimitOverrideDoc;
}

/** ==================== loan_applications ==================== */

export interface LoanApplicationDoc {
  applicationNumber: string;
  userId: string;
  productId: string;
  requestedAmountPesos: number;
  termInstallments: number;
  termFrequency: TermFrequency;
  status: ApplicationStatus;
  decisionNotes?: string;
  reviewedBy?: string;
  reviewedAt?: CreditDocDate;
  createdAt: CreditDocDate;
  updatedAt: CreditDocDate;
}

export interface BuildLoanApplicationInput {
  applicationNumber: string;
  userId: string;
  productId: string;
  requestedAmountPesos: number;
  termInstallments: number;
  termFrequency: TermFrequency;
  status?: ApplicationStatus;
  decisionNotes?: string;
  reviewedBy?: string;
  reviewedAt?: CreditDocDate;
}

export const loanApplicationDocSchema = z
  .object({
    applicationNumber: z.string().trim().min(1).max(50),
    userId: z.string().trim().min(1),
    productId: z.string().trim().min(1),
    requestedAmountPesos: z.number().int().positive(),
    termInstallments: z.number().int().positive(),
    termFrequency: z.enum([TermFrequency.WEEKLY, TermFrequency.BIWEEKLY, TermFrequency.MONTHLY]),
    status: z.enum([
      ApplicationStatus.DRAFT,
      ApplicationStatus.SUBMITTED,
      ApplicationStatus.UNDER_REVIEW,
      ApplicationStatus.APPROVED,
      ApplicationStatus.REJECTED,
    ]),
    decisionNotes: z.string().trim().max(2000).optional(),
    reviewedBy: z.string().trim().min(1).optional(),
    reviewedAt: creditDocDateOptional,
    createdAt: creditDocDateSchema,
    updatedAt: creditDocDateSchema,
  })
  .strict();

export function buildLoanApplicationDoc(input: BuildLoanApplicationInput, now: Date): LoanApplicationDoc {
  const candidate: LoanApplicationDoc = {
    applicationNumber: input.applicationNumber,
    userId: input.userId,
    productId: input.productId,
    requestedAmountPesos: input.requestedAmountPesos,
    termInstallments: input.termInstallments,
    termFrequency: input.termFrequency,
    status: input.status ?? ApplicationStatus.DRAFT,
    decisionNotes: input.decisionNotes,
    reviewedBy: input.reviewedBy,
    reviewedAt: input.reviewedAt,
    createdAt: now,
    updatedAt: now,
  };
  return loanApplicationDocSchema.parse(candidate) as LoanApplicationDoc;
}

/** ==================== loans ==================== */

/**
 * Estados que cuentan como "préstamo activo": el usuario no puede tener dos.
 * `PAID` (saldado) y `WRITTEN_OFF` (condonado) liberan el cupo.
 */
export const ACTIVE_LOAN_STATUSES = [
  LoanStatus.PENDING_DISBURSEMENT,
  LoanStatus.DISBURSED,
  LoanStatus.DEFAULTED,
] as const;

export function isActiveLoanStatus(status: LoanStatus): boolean {
  return (ACTIVE_LOAN_STATUSES as readonly LoanStatus[]).includes(status);
}

/**
 * Base de cálculo congelada en el momento en que se creó el préstamo.
 *
 * El desembolso (F9) recalcula el calendario cuando la transferencia es real. Si para eso
 * volviera a leer `interest_rates` o `credit_products`, una tasa o tarifa nueva le cambiaría
 * los pesos al cliente después de aceptar el préstamo. Con el snapshot, el recálculo es
 * determinista y solo mueve fechas: los importes salen de `interestPesos`/`feePesos` y de las
 * cuotas ya escritas.
 */
export interface LoanPricingSnapshot {
  annualRateBps: number;
  effectiveFeeBps: number;
  rateVersion: number;
  termInstallments: number;
  termFrequency: TermFrequency;
}

export const loanPricingSnapshotSchema = z
  .object({
    annualRateBps: z.number().int().min(0),
    effectiveFeeBps: z.number().int().min(0),
    rateVersion: z.number().int().positive(),
    termInstallments: z.number().int().positive(),
    termFrequency: z.enum([TermFrequency.WEEKLY, TermFrequency.BIWEEKLY, TermFrequency.MONTHLY]),
  })
  .strict();

export interface LoanDoc {
  loanNumber: string;
  applicationId: string;
  userId: string;
  productCode: string;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  totalPayablePesos: number;
  pricing: LoanPricingSnapshot;
  status: LoanStatus;
  delinquencyStatus?: DelinquencyStatus;
  daysPastDue?: number;
  outstandingPesos?: number;
  disbursedAt?: CreditDocDate;
  paidAt?: CreditDocDate;
  createdAt: CreditDocDate;
  updatedAt: CreditDocDate;
}

export interface BuildLoanInput {
  loanNumber: string;
  applicationId: string;
  userId: string;
  productCode: string;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  pricing: LoanPricingSnapshot;
  status?: LoanStatus;
  delinquencyStatus?: DelinquencyStatus;
  daysPastDue?: number;
  outstandingPesos?: number;
  disbursedAt?: CreditDocDate;
  paidAt?: CreditDocDate;
}

const loanStatusSchema = z.enum([
  LoanStatus.PENDING_DISBURSEMENT,
  LoanStatus.DISBURSED,
  LoanStatus.PAID,
  LoanStatus.DEFAULTED,
  LoanStatus.WRITTEN_OFF,
]);

export const loanDocSchema = z
  .object({
    loanNumber: z.string().trim().min(1).max(50),
    applicationId: z.string().trim().min(1),
    userId: z.string().trim().min(1),
    productCode: z.string().trim().min(1),
    principalPesos: z.number().int().positive(),
    interestPesos: z.number().int().min(0),
    feePesos: z.number().int().min(0),
    // Invariante de dinero: lo que se paga es exactamente la suma de las partes.
    totalPayablePesos: z.number().int().positive(),
    // Base de cálculo congelada: permite recalcular el calendario en F9 sin volver a leer
    // la tasa vigente (que pudo cambiar) y sin mover un peso de lo aceptado.
    pricing: loanPricingSnapshotSchema,
    status: loanStatusSchema,
    delinquencyStatus: z
      .enum([
        DelinquencyStatus.CURRENT,
        DelinquencyStatus.DUE_SOON,
        DelinquencyStatus.DUE_TODAY,
        DelinquencyStatus.OVERDUE,
        DelinquencyStatus.DEFAULT,
        DelinquencyStatus.PAID,
      ])
      .optional(),
    daysPastDue: z.number().int().min(0).optional(),
    outstandingPesos: z.number().int().min(0).optional(),
    disbursedAt: creditDocDateOptional,
    paidAt: creditDocDateOptional,
    createdAt: creditDocDateSchema,
    updatedAt: creditDocDateSchema,
  })
  .strict();

export function buildLoanDoc(input: BuildLoanInput, now: Date): LoanDoc {
  const totalPayablePesos = add(add(input.principalPesos, input.interestPesos), input.feePesos);
  const candidate: LoanDoc = {
    loanNumber: input.loanNumber,
    applicationId: input.applicationId,
    userId: input.userId,
    productCode: input.productCode,
    principalPesos: input.principalPesos,
    interestPesos: input.interestPesos,
    feePesos: input.feePesos,
    totalPayablePesos,
    pricing: input.pricing,
    status: input.status ?? LoanStatus.PENDING_DISBURSEMENT,
    delinquencyStatus: input.delinquencyStatus,
    daysPastDue: input.daysPastDue,
    outstandingPesos: input.outstandingPesos ?? totalPayablePesos,
    disbursedAt: input.disbursedAt,
    paidAt: input.paidAt,
    createdAt: now,
    updatedAt: now,
  };
  return loanDocSchema.parse(candidate) as LoanDoc;
}

/** ==================== disbursements ==================== */

/**
 * Doc ID determinista = `loanId`: un préstamo solo tiene un desembolso, y el id fijo evita
 * que un doble clic cree dos.
 */
export const disbursementDocSchema = z
  .object({
    loanId: z.string().trim().min(1),
    provider: z.literal("manual"),
    status: z.enum([
      DisbursementStatus.PENDING,
      DisbursementStatus.INITIATED,
      DisbursementStatus.CONFIRMED,
      DisbursementStatus.CANCELLED,
    ]),
    /** Referencia de la transferencia. Obligatoria antes de poder confirmar. */
    reference: z.string().trim().min(1).max(120).optional(),
    initiatedBy: z.string().trim().min(1),
    initiatedAt: creditDocDateSchema,
    confirmedBy: z.string().trim().min(1).optional(),
    confirmedAt: creditDocDateOptional,
    /**
     * Clave de idempotencia de la operación que **originó** el doc (el initiate). La del
     * confirm no se guarda aquí: el estado `CONFIRMED` ya lo hace único, y meterla pisaría
     * esta.
     */
    idempotencyKey: z.string().trim().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type DisbursementDoc = z.infer<typeof disbursementDocSchema>;

/** ==================== loan_installments ==================== */

export interface LoanInstallmentDoc {
  loanId: string;
  installmentNumber: number;
  dueDate: CreditDocDate;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  totalPesos: number;
  paidPesos: number;
  status: InstallmentStatus;
  paidAt?: CreditDocDate;
  /** Pago que **salda** la cuota (F10-2b). */
  paymentId?: string;
  /**
   * Pago `PENDING` que espera confirmación humana, si lo hay (F10-2).
   *
   * No está en la línea de §8.1 y es una extensión deliberada: funciona como candado. Se escribe
   * en la misma transacción que crea el pago, de modo que dos registros simultáneos de la misma
   * cuota se serializan (write-write conflict) y el segundo recibe 409 en vez de dejar dos pagos
   * PENDING que el admin tendría que depurar a mano. Lo libera el rechazo del pago.
   */
  pendingPaymentId?: string;
}

export interface BuildLoanInstallmentInput {
  loanId: string;
  installmentNumber: number;
  dueDate: CreditDocDate;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  paidPesos?: number;
  status?: InstallmentStatus;
  paidAt?: CreditDocDate;
  paymentId?: string;
  pendingPaymentId?: string;
}

/** Doc ID determinista `${loanId}_${n}`: ordena sin query y evita cuotas duplicadas. */
export function loanInstallmentDocId(loanId: string, installmentNumber: number): string {
  assertSafeInteger(installmentNumber, "installmentNumber");
  if (installmentNumber < 1) {
    throw new RangeError("installmentNumber debe ser >= 1");
  }
  return `${loanId}_${installmentNumber}`;
}

export const loanInstallmentDocSchema = z
  .object({
    loanId: z.string().trim().min(1),
    installmentNumber: z.number().int().positive(),
    dueDate: creditDocDateSchema,
    principalPesos: z.number().int().min(0),
    interestPesos: z.number().int().min(0),
    feePesos: z.number().int().min(0),
    totalPesos: z.number().int().positive(),
    paidPesos: z.number().int().min(0),
    status: z.enum([InstallmentStatus.PENDING, InstallmentStatus.PAID]),
    paidAt: creditDocDateOptional,
    paymentId: z.string().trim().min(1).optional(),
    pendingPaymentId: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * El doc de cuota no lleva marca de tiempo de creación (PROJECT_SPEC §8.1): su única
 * fecha es `dueDate`. Por eso no recibe `now`.
 */
export function buildLoanInstallmentDoc(input: BuildLoanInstallmentInput): LoanInstallmentDoc {
  const totalPesos = add(add(input.principalPesos, input.interestPesos), input.feePesos);
  const candidate: LoanInstallmentDoc = {
    loanId: input.loanId,
    installmentNumber: input.installmentNumber,
    dueDate: input.dueDate,
    principalPesos: input.principalPesos,
    interestPesos: input.interestPesos,
    feePesos: input.feePesos,
    totalPesos,
    paidPesos: input.paidPesos ?? 0,
    status: input.status ?? InstallmentStatus.PENDING,
    paidAt: input.paidAt,
    paymentId: input.paymentId,
    pendingPaymentId: input.pendingPaymentId,
  };
  return loanInstallmentDocSchema.parse(candidate) as LoanInstallmentDoc;
}

/** ==================== system_config ==================== */

export interface SystemConfigDoc {
  value: Record<string, unknown>;
  updatedBy: string;
  updatedAt: CreditDocDate;
}

export interface BuildSystemConfigInput {
  value: Record<string, unknown>;
  updatedBy: string;
}

export const systemConfigDocSchema = z
  .object({
    value: z.record(z.string(), z.unknown()),
    updatedBy: z.string().trim().min(1),
    updatedAt: creditDocDateSchema,
  })
  .strict();

export function buildSystemConfigDoc(input: BuildSystemConfigInput, now: Date): SystemConfigDoc {
  const candidate: SystemConfigDoc = {
    value: input.value,
    updatedBy: input.updatedBy,
    updatedAt: now,
  };
  return systemConfigDocSchema.parse(candidate) as SystemConfigDoc;
}

/** ==================== risk_rules ==================== */

export interface RiskRuleDoc {
  name: string;
  kind: string;
  params: Record<string, unknown>;
  version: number;
  isActive: boolean;
  effectiveFrom?: CreditDocDate;
  effectiveTo?: CreditDocDate;
  source: string;
  createdAt: CreditDocDate;
  updatedAt: CreditDocDate;
}

export interface BuildRiskRuleInput {
  name: string;
  kind: string;
  params: Record<string, unknown>;
  version: number;
  isActive?: boolean;
  effectiveFrom?: CreditDocDate;
  effectiveTo?: CreditDocDate;
  source: string;
}

export const riskRuleDocSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.string().trim().min(1).max(50),
    params: z.record(z.string(), z.unknown()),
    version: z.number().int().positive(),
    isActive: z.boolean().default(true),
    effectiveFrom: creditDocDateOptional,
    effectiveTo: creditDocDateOptional,
    source: z.string().trim().min(1).max(200),
    createdAt: creditDocDateSchema,
    updatedAt: creditDocDateSchema,
  })
  .strict();

export function buildRiskRuleDoc(input: BuildRiskRuleInput, now: Date): RiskRuleDoc {
  const candidate: RiskRuleDoc = {
    name: input.name,
    kind: input.kind,
    params: input.params,
    version: input.version,
    isActive: input.isActive ?? true,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };
  return riskRuleDocSchema.parse(candidate) as RiskRuleDoc;
}

/** ==================== interest_rates ==================== */

export interface InterestRateDoc {
  productType: string;
  annualRateBps: number;
  maximumRateBps?: number;
  effectiveFrom: CreditDocDate;
  effectiveTo?: CreditDocDate;
  source: string;
  version: number;
  isActive: boolean;
  createdAt: CreditDocDate;
  updatedAt: CreditDocDate;
}

export interface BuildInterestRateInput {
  productType: string;
  annualRateBps: number;
  maximumRateBps?: number;
  effectiveFrom: CreditDocDate;
  effectiveTo?: CreditDocDate;
  source: string;
  version: number;
  isActive?: boolean;
}

export const interestRateDocSchema = z
  .object({
    productType: z.string().trim().min(1).max(50),
    annualRateBps: z.number().int().min(0).max(100000),
    maximumRateBps: z.number().int().min(0).max(100000).optional(),
    effectiveFrom: creditDocDateSchema,
    effectiveTo: creditDocDateOptional,
    source: z.string().trim().min(1).max(200),
    version: z.number().int().positive(),
    isActive: z.boolean().default(true),
    createdAt: creditDocDateSchema,
    updatedAt: creditDocDateSchema,
  })
  .strict()
  .refine(
    (doc) => doc.effectiveTo === undefined || toMillisOrNull(doc.effectiveTo)! > toMillisOrNull(doc.effectiveFrom)!,
    {
      message: "effectiveTo debe ser posterior a effectiveFrom: una tasa no puede vencer antes de empezar",
      path: ["effectiveTo"],
    },
  );

/** `Date` o `Timestamp` → milisegundos; `null` si no se puede leer (el refine solo compara números). */
function toMillisOrNull(value: CreditDocDate): number | null {
  if (value instanceof Date) return value.getTime();
  return value.toMillis();
}

export function buildInterestRateDoc(input: BuildInterestRateInput, now: Date): InterestRateDoc {
  const candidate: InterestRateDoc = {
    productType: input.productType,
    annualRateBps: input.annualRateBps,
    maximumRateBps: input.maximumRateBps,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    source: input.source,
    version: input.version,
    isActive: input.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };
  return interestRateDocSchema.parse(candidate) as InterestRateDoc;
}

/** ==================== credit_scores ==================== */

export interface CreditScoreDoc {
  userId: string;
  applicationId?: string;
  score: number;
  riskLevel: string;
  factors: {
    factorKey: string;
    label: string;
    weightBps: number;
    value: number | string | boolean;
    contributionBps: number;
    reason: string;
  }[];
  modelVersion: string;
  calculatedAt: CreditDocDate;
}

export interface BuildCreditScoreInput {
  userId: string;
  applicationId?: string;
  score: number;
  riskLevel: string;
  factors: {
    factorKey: string;
    label: string;
    weightBps: number;
    value: number | string | boolean;
    contributionBps: number;
    reason: string;
  }[];
  modelVersion: string;
  calculatedAt: CreditDocDate;
}

export const creditScoreDocSchema = z
  .object({
    userId: z.string().trim().min(1),
    applicationId: z.string().trim().min(1).optional(),
    score: z.number().int().min(0).max(100),
    riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
    factors: z.array(
      z.object({
        factorKey: z.string().trim().min(1),
        label: z.string().trim().min(1),
        weightBps: z.number().int().positive(),
        value: z.union([z.number(), z.string(), z.boolean()]),
        contributionBps: z.number().int(),
        reason: z.string().trim().min(1),
      }),
    ),
    modelVersion: z.string().trim().min(1),
    calculatedAt: creditDocDateSchema,
  })
  .strict();

export function buildCreditScoreDoc(input: BuildCreditScoreInput, _now: Date): CreditScoreDoc {
  const candidate: CreditScoreDoc = {
    userId: input.userId,
    applicationId: input.applicationId,
    score: input.score,
    riskLevel: input.riskLevel,
    factors: input.factors,
    modelVersion: input.modelVersion,
    calculatedAt: input.calculatedAt,
  };
  return creditScoreDocSchema.parse(candidate) as CreditScoreDoc;
}