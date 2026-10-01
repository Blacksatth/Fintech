import { assertSafeInteger } from "./money";
import { ApplicationStatus, CreditProductDoc, ProductTierDoc, LoanApplicationDoc, DEFAULT_PRODUCT_TERM_RANGE } from "./credit-doc";

export interface EligibleTierResult {
  tier: ProductTierDoc | null;
  product: CreditProductDoc | null;
  canApply: boolean;
  reason?: string;
}

import { TermFrequency } from "./types";

export interface CreateApplicationInput {
  userId: string;
  productId: string;
  requestedAmountPesos: number;
  termInstallments: number;
  termFrequency: TermFrequency;
}

export interface ApplicationResult {
  application: LoanApplicationDoc;
  eligibleTier: EligibleTierResult;
}

export function generateApplicationNumber(): string {
  const now = new Date();
  const year = now.getFullYear();
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `APP-${year}-${random}`;
}

/**
 * Baja el tier elegible al mayor tier (por monto) cuyo monto cabe en el límite de crédito del
 * usuario (`user_limit_overrides`, F13-2). Si el límite no alcanza ni el menor monto del producto,
 * no hay tier: quien lo llame debe marcar `canApply: false`.
 */
export function capTierByCreditLimit(
  tiers: ProductTierDoc[],
  eligibleTier: ProductTierDoc,
  creditLimitPesos: number,
): ProductTierDoc | null {
  const creditLimit = assertSafeInteger(creditLimitPesos, "creditLimitPesos");
  if (creditLimit >= eligibleTier.amountPesos) return eligibleTier;

  const candidates = tiers.filter(
    (t) => t.isActive && t.productCode === eligibleTier.productCode && t.amountPesos <= creditLimit,
  );
  if (candidates.length === 0) return null;

  return candidates.reduce((best, current) =>
    current.amountPesos > best.amountPesos ||
    (current.amountPesos === best.amountPesos && current.position > best.position)
      ? current
      : best,
  );
}

export function findEligibleTier(
  userId: string,
  product: CreditProductDoc,
  tiers: ProductTierDoc[],
  userLoanHistory: { completedLoans: number; activeLoans: number; defaultedLoans: number },
  productCode: string,
  /** Límite de crédito por usuario (`user_limit_overrides`, F13-2); sin él no hay cap. */
  creditLimitPesos?: number,
): EligibleTierResult {
  const activeTiers = tiers.filter((t) => t.isActive && t.productCode === productCode).sort((a, b) => a.position - b.position);

  if (activeTiers.length === 0) {
    return { tier: null, product, canApply: false, reason: "No hay tiers activos para este producto" };
  }

  if (userLoanHistory.activeLoans > 0) {
    return { tier: null, product, canApply: false, reason: "El usuario ya tiene un préstamo activo" };
  }

  const eligiblePosition = Math.min(userLoanHistory.completedLoans + 1, activeTiers.length);
  let eligible: ProductTierDoc | null = activeTiers[eligiblePosition - 1];

  if (userLoanHistory.defaultedLoans > 0 && eligiblePosition > 1) {
    eligible = activeTiers[Math.max(1, eligiblePosition - 1) - 1];
  }

  if (creditLimitPesos !== undefined) {
    eligible = capTierByCreditLimit(tiers, eligible!, creditLimitPesos);
    if (!eligible) {
      return {
        tier: null,
        product,
        canApply: false,
        reason: `El límite de crédito del usuario (${creditLimitPesos} pesos) no alcanza el monto mínimo disponible`,
      };
    }
  }

  return { tier: eligible, product, canApply: true };
}

export function validateApplicationAmount(
  requestedAmountPesos: number,
  eligibleTier: ProductTierDoc | null,
): { valid: boolean; reason?: string } {
  if (!eligibleTier) {
    return { valid: false, reason: "No hay tier elegible" };
  }

  const expectedAmount = eligibleTier.amountPesos;
  if (requestedAmountPesos !== expectedAmount) {
    return {
      valid: false,
      reason: `El monto solicitado (${requestedAmountPesos}) no coincide con el tier elegible (${expectedAmount})`,
    };
  }

  return { valid: true };
}

/**
 * Valida el término elegido contra el producto (F8 + regla de plazo).
 *
 * La frecuencia es **única por producto**: el cliente elige cuántas cuotas, nunca la
 * periodicidad. El número elegido debe caer en `[minTermInstallments, maxTermInstallments]`
 * (mínimo 2). Los defaults cubren docs legados sembrados antes de declarar el rango.
 */
export function validateApplicationTerm(
  product: Pick<CreditProductDoc, "termFrequency" | "minTermInstallments" | "maxTermInstallments">,
  termInstallments: number,
  termFrequency: TermFrequency,
  termFrequencyLabel: (frequency: TermFrequency) => string,
): { valid: boolean; reason?: string } {
  if (termFrequency !== product.termFrequency) {
    return {
      valid: false,
      reason: `La frecuencia del producto es ${termFrequencyLabel(product.termFrequency)}; se registró ${termFrequencyLabel(termFrequency)}`,
    };
  }
  const min = product.minTermInstallments ?? DEFAULT_PRODUCT_TERM_RANGE.min;
  const max = product.maxTermInstallments ?? DEFAULT_PRODUCT_TERM_RANGE.max;
  if (!Number.isSafeInteger(termInstallments) || termInstallments < min || termInstallments > max) {
    return { valid: false, reason: `El plazo debe ser de ${min} a ${max} cuotas ${termFrequencyLabel(termFrequency).toLowerCase()}` };
  }
  return { valid: true };
}

export function createLoanApplicationDraft(
  input: CreateApplicationInput,
  product: CreditProductDoc,
  eligibleTier: ProductTierDoc,
  now: Date,
  termFrequencyLabel?: (frequency: TermFrequency) => string,
): LoanApplicationDoc {
  const termInstallments = assertSafeInteger(input.termInstallments, "termInstallments");
  const termCheck = validateApplicationTerm(
    product,
    termInstallments,
    input.termFrequency,
    termFrequencyLabel ?? defaultTermFrequencyLabel,
  );
  if (!termCheck.valid) {
    throw new RangeError(termCheck.reason);
  }
  return {
    applicationNumber: generateApplicationNumber(),
    userId: input.userId,
    productId: input.productId,
    requestedAmountPesos: assertSafeInteger(input.requestedAmountPesos, "requestedAmountPesos"),
    termInstallments,
    termFrequency: input.termFrequency,
    status: ApplicationStatus.DRAFT,
    createdAt: now,
    updatedAt: now,
  };
}

/** Etiqueta neutra sin depender de `credit-labels` (dominio puro). */
function defaultTermFrequencyLabel(frequency: TermFrequency): string {
  return frequency;
}

export function submitLoanApplication(
  draft: LoanApplicationDoc,
  now: Date,
): LoanApplicationDoc {
  if (draft.status !== ApplicationStatus.DRAFT) {
    throw new Error("Solo se puede presentar una solicitud en estado DRAFT");
  }
  return {
    ...draft,
    status: ApplicationStatus.SUBMITTED,
    updatedAt: now,
  };
}