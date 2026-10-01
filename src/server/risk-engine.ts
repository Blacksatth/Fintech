import { RiskLevel } from "./types";

export interface RiskFactor {
  factorKey: string;
  label: string;
  weightBps: number;
  value: number | string | boolean;
  contributionBps: number;
  reason: string;
}

export interface ScoreResult {
  score: number;
  riskLevel: RiskLevel;
  factors: RiskFactor[];
  modelVersion: string;
  calculatedAt: Date;
}

export interface RiskEngine {
  calculate(ctx: RiskContext): Promise<ScoreResult>;
}

export interface RiskContext {
  userId: string;
  applicationId?: string;
  identityVerified: boolean;
  incomeVerifiable: boolean;
  monthlyIncomeRange?: string;
  debtToIncomeRatio: number;
  loanHistoryCount: number;
  paymentHistoryScore: number;
  previousDelinquency: boolean;
  applicationCount: number;
}

export interface RiskRuleConfig {
  name: string;
  kind: string;
  weightBps: number;
  params: Record<string, unknown>;
}

export const RISK_LEVEL_THRESHOLDS = {
  LOW_MIN: 70,
  MEDIUM_MIN: 45,
} as const;

export function riskLevelFromScore(score: number): RiskLevel {
  if (score >= RISK_LEVEL_THRESHOLDS.LOW_MIN) return RiskLevel.LOW;
  if (score >= RISK_LEVEL_THRESHOLDS.MEDIUM_MIN) return RiskLevel.MEDIUM;
  return RiskLevel.HIGH;
}

export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function calculateFactorContribution(weightBps: number, normalizedValue: number): number {
  return Math.round((weightBps * normalizedValue) / 10000 * 100);
}

export function normalizeIdentityVerified(verified: boolean): number {
  return verified ? 1 : 0;
}

export function normalizeIncomeVerifiable(verifiable: boolean): number {
  return verifiable ? 1 : 0;
}

export function normalizeDebtToIncome(ratio: number): number {
  if (ratio <= 0.2) return 1;
  if (ratio <= 0.3) return 0.8;
  if (ratio <= 0.4) return 0.6;
  if (ratio <= 0.5) return 0.4;
  return 0;
}

export function normalizeLoanHistory(count: number): number {
  if (count >= 3) return 1;
  if (count === 2) return 0.7;
  if (count === 1) return 0.4;
  return 0;
}

export function normalizePaymentHistory(score: number): number {
  return Math.max(0, Math.min(1, score / 100));
}

export function normalizePreviousDelinquency(delinquent: boolean): number {
  return delinquent ? 0 : 1;
}

export function normalizeApplicationCount(count: number): number {
  if (count <= 1) return 1;
  if (count === 2) return 0.7;
  if (count === 3) return 0.4;
  return 0;
}

export class RuleBasedRiskEngine implements RiskEngine {
  private rules: RiskRuleConfig[];
  private modelVersion: string;

  constructor(rules: RiskRuleConfig[], modelVersion = "v1.0.0") {
    this.rules = rules.filter((r) => r.kind !== "MANUAL_OVERRIDE");
    this.modelVersion = modelVersion;
  }

  async calculate(ctx: RiskContext): Promise<ScoreResult> {
    const factors: RiskFactor[] = [];
    let totalScore = 0;

    for (const rule of this.rules) {
      const factor = this.evaluateRule(rule, ctx);
      factors.push(factor);
      totalScore += factor.contributionBps;
    }

    const finalScore = clampScore(totalScore);
    const riskLevel = riskLevelFromScore(finalScore);

    return {
      score: finalScore,
      riskLevel,
      factors,
      modelVersion: this.modelVersion,
      calculatedAt: new Date(),
    };
  }

  private evaluateRule(rule: RiskRuleConfig, ctx: RiskContext): RiskFactor {
    let normalizedValue = 0;
    let reason = "";

    switch (rule.kind) {
      case "IDENTITY_VERIFIED": {
        normalizedValue = normalizeIdentityVerified(ctx.identityVerified);
        reason = ctx.identityVerified
          ? "Identidad verificada correctamente"
          : "Identidad no verificada";
        break;
      }
      case "INCOME_VERIFIABLE": {
        normalizedValue = normalizeIncomeVerifiable(ctx.incomeVerifiable);
        reason = ctx.incomeVerifiable
          ? "Ingresos verificables"
          : "Ingresos no verificables";
        break;
      }
      case "DEBT_TO_INCOME": {
        normalizedValue = normalizeDebtToIncome(ctx.debtToIncomeRatio);
        reason = `Ratio deuda/ingreso: ${(ctx.debtToIncomeRatio * 100).toFixed(1)}%`;
        break;
      }
      case "LOAN_HISTORY": {
        normalizedValue = normalizeLoanHistory(ctx.loanHistoryCount);
        reason = `${ctx.loanHistoryCount} préstamos previos pagados`;
        break;
      }
      case "PAYMENT_HISTORY": {
        normalizedValue = normalizePaymentHistory(ctx.paymentHistoryScore);
        reason = `Score de pagos: ${ctx.paymentHistoryScore}/100`;
        break;
      }
      case "PREVIOUS_DELINQUENCY": {
        normalizedValue = normalizePreviousDelinquency(ctx.previousDelinquency);
        reason = ctx.previousDelinquency
          ? "Tiene moras previas"
          : "Sin moras previas";
        break;
      }
      case "APPLICATION_COUNT": {
        normalizedValue = normalizeApplicationCount(ctx.applicationCount);
        reason = `${ctx.applicationCount} solicitudes recientes`;
        break;
      }
      default: {
        normalizedValue = 0;
        reason = "Regla no reconocida";
      }
    }

    const contributionBps = calculateFactorContribution(rule.weightBps, normalizedValue);

    return {
      factorKey: rule.kind,
      label: rule.name,
      weightBps: rule.weightBps,
      value: normalizedValue,
      contributionBps,
      reason,
    };
  }
}

export function createDefaultRiskEngine(modelVersion = "v1.0.0"): RuleBasedRiskEngine {
  const defaultRules: RiskRuleConfig[] = [
    { name: "Identidad verificada", kind: "IDENTITY_VERIFIED", weightBps: 1500, params: {} },
    { name: "Ingresos verificables", kind: "INCOME_VERIFIABLE", weightBps: 2000, params: {} },
    { name: "Capacidad de pago", kind: "DEBT_TO_INCOME", weightBps: 2500, params: { maxRatio: 0.4 } },
    { name: "Historial de préstamos", kind: "LOAN_HISTORY", weightBps: 1500, params: {} },
    { name: "Historial de pagos", kind: "PAYMENT_HISTORY", weightBps: 1500, params: {} },
    { name: "Moras previas", kind: "PREVIOUS_DELINQUENCY", weightBps: 1000, params: {} },
    { name: "Número de solicitudes", kind: "APPLICATION_COUNT", weightBps: 500, params: {} },
  ];
  return new RuleBasedRiskEngine(defaultRules, modelVersion);
}