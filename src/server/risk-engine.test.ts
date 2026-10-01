import { describe, expect, it } from "vitest";
import {
  RuleBasedRiskEngine,
  createDefaultRiskEngine,
  clampScore,
  riskLevelFromScore,
  normalizeIdentityVerified,
  normalizeIncomeVerifiable,
  normalizeDebtToIncome,
  normalizeLoanHistory,
  normalizePaymentHistory,
  normalizePreviousDelinquency,
  normalizeApplicationCount,
  calculateFactorContribution,
} from "./risk-engine";
import { RiskLevel } from "./types";

describe("risk-engine - normalizers", () => {
  describe("normalizeIdentityVerified", () => {
    it("returns 1 for true", () => {
      expect(normalizeIdentityVerified(true)).toBe(1);
    });
    it("returns 0 for false", () => {
      expect(normalizeIdentityVerified(false)).toBe(0);
    });
  });

  describe("normalizeIncomeVerifiable", () => {
    it("returns 1 for true", () => {
      expect(normalizeIncomeVerifiable(true)).toBe(1);
    });
    it("returns 0 for false", () => {
      expect(normalizeIncomeVerifiable(false)).toBe(0);
    });
  });

  describe("normalizeDebtToIncome", () => {
    it("returns 1 for ratio <= 0.2", () => {
      expect(normalizeDebtToIncome(0.1)).toBe(1);
      expect(normalizeDebtToIncome(0.2)).toBe(1);
    });
    it("returns 0.8 for ratio <= 0.3", () => {
      expect(normalizeDebtToIncome(0.25)).toBe(0.8);
      expect(normalizeDebtToIncome(0.3)).toBe(0.8);
    });
    it("returns 0.6 for ratio <= 0.4", () => {
      expect(normalizeDebtToIncome(0.35)).toBe(0.6);
      expect(normalizeDebtToIncome(0.4)).toBe(0.6);
    });
    it("returns 0.4 for ratio <= 0.5", () => {
      expect(normalizeDebtToIncome(0.45)).toBe(0.4);
      expect(normalizeDebtToIncome(0.5)).toBe(0.4);
    });
    it("returns 0 for ratio > 0.5", () => {
      expect(normalizeDebtToIncome(0.6)).toBe(0);
      expect(normalizeDebtToIncome(1.0)).toBe(0);
    });
  });

  describe("normalizeLoanHistory", () => {
    it("returns 1 for >= 3 loans", () => {
      expect(normalizeLoanHistory(3)).toBe(1);
      expect(normalizeLoanHistory(5)).toBe(1);
    });
    it("returns 0.7 for 2 loans", () => {
      expect(normalizeLoanHistory(2)).toBe(0.7);
    });
    it("returns 0.4 for 1 loan", () => {
      expect(normalizeLoanHistory(1)).toBe(0.4);
    });
    it("returns 0 for 0 loans", () => {
      expect(normalizeLoanHistory(0)).toBe(0);
    });
  });

  describe("normalizePaymentHistory", () => {
    it("returns 1 for score 100", () => {
      expect(normalizePaymentHistory(100)).toBe(1);
    });
    it("returns 0.5 for score 50", () => {
      expect(normalizePaymentHistory(50)).toBe(0.5);
    });
    it("returns 0 for score 0", () => {
      expect(normalizePaymentHistory(0)).toBe(0);
    });
    it("clamps values outside 0-100", () => {
      expect(normalizePaymentHistory(-10)).toBe(0);
      expect(normalizePaymentHistory(150)).toBe(1);
    });
  });

  describe("normalizePreviousDelinquency", () => {
    it("returns 0 for true", () => {
      expect(normalizePreviousDelinquency(true)).toBe(0);
    });
    it("returns 1 for false", () => {
      expect(normalizePreviousDelinquency(false)).toBe(1);
    });
  });

  describe("normalizeApplicationCount", () => {
    it("returns 1 for <= 1", () => {
      expect(normalizeApplicationCount(0)).toBe(1);
      expect(normalizeApplicationCount(1)).toBe(1);
    });
    it("returns 0.7 for 2", () => {
      expect(normalizeApplicationCount(2)).toBe(0.7);
    });
    it("returns 0.4 for 3", () => {
      expect(normalizeApplicationCount(3)).toBe(0.4);
    });
    it("returns 0 for >= 4", () => {
      expect(normalizeApplicationCount(4)).toBe(0);
      expect(normalizeApplicationCount(10)).toBe(0);
    });
  });

  describe("calculateFactorContribution", () => {
    it("calculates contribution correctly", () => {
      expect(calculateFactorContribution(1500, 1)).toBe(15); // 1500/10000 * 100 = 15
      expect(calculateFactorContribution(2000, 0.5)).toBe(10); // 2000/10000 * 0.5 * 100 = 10
      expect(calculateFactorContribution(2500, 0)).toBe(0);
    });
  });

  describe("clampScore", () => {
    it("clamps to 0-100", () => {
      expect(clampScore(-50)).toBe(0);
      expect(clampScore(0)).toBe(0);
      expect(clampScore(50)).toBe(50);
      expect(clampScore(100)).toBe(100);
      expect(clampScore(150)).toBe(100);
    });
    it("rounds correctly", () => {
      expect(clampScore(49.4)).toBe(49);
      expect(clampScore(49.5)).toBe(50);
      expect(clampScore(49.6)).toBe(50);
    });
  });

  describe("riskLevelFromScore", () => {
    it("returns LOW for >= 70", () => {
      expect(riskLevelFromScore(70)).toBe("LOW");
      expect(riskLevelFromScore(100)).toBe("LOW");
    });
    it("returns MEDIUM for 45-69", () => {
      expect(riskLevelFromScore(45)).toBe("MEDIUM");
      expect(riskLevelFromScore(69)).toBe("MEDIUM");
    });
    it("returns HIGH for < 45", () => {
      expect(riskLevelFromScore(44)).toBe("HIGH");
      expect(riskLevelFromScore(0)).toBe("HIGH");
    });
  });
});

describe("RuleBasedRiskEngine", () => {
  const createContext = (overrides: Partial<{
    identityVerified: boolean;
    incomeVerifiable: boolean;
    monthlyIncomeRange: string;
    debtToIncomeRatio: number;
    loanHistoryCount: number;
    paymentHistoryScore: number;
    previousDelinquency: boolean;
    applicationCount: number;
  }> = {}) => ({
    userId: "test-user",
    identityVerified: true,
    incomeVerifiable: true,
    monthlyIncomeRange: "2M-4M",
    debtToIncomeRatio: 0.3,
    loanHistoryCount: 1,
    paymentHistoryScore: 80,
    previousDelinquency: false,
    applicationCount: 1,
    ...overrides,
  });

  it("calculates score for ideal profile", async () => {
    const engine = createDefaultRiskEngine();
    const ctx = createContext({
      debtToIncomeRatio: 0.1,
      loanHistoryCount: 3,
      paymentHistoryScore: 100,
    });

    const result = await engine.calculate(ctx);

    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.riskLevel).toBe("LOW");
    expect(result.factors).toHaveLength(7);
    expect(result.modelVersion).toBe("v1.0.0");
  });

  it("calculates score for risky profile", async () => {
    const engine = createDefaultRiskEngine();
    const ctx = createContext({
      identityVerified: false,
      incomeVerifiable: false,
      debtToIncomeRatio: 0.6,
      loanHistoryCount: 0,
      paymentHistoryScore: 20,
      previousDelinquency: true,
      applicationCount: 5,
    });

    const result = await engine.calculate(ctx);

    expect(result.score).toBeLessThan(45);
    expect(result.riskLevel).toBe("HIGH");
  });

  it("calculates MEDIUM risk for borderline profile", async () => {
    const engine = createDefaultRiskEngine();
    const ctx = createContext({
      identityVerified: true,
      incomeVerifiable: true,
      debtToIncomeRatio: 0.4,
      loanHistoryCount: 0,
      paymentHistoryScore: 40,
      applicationCount: 3,
    });

    const result = await engine.calculate(ctx);

    expect(result.score).toBeGreaterThanOrEqual(45);
    expect(result.riskLevel).toBe("MEDIUM");
  });

  it("returns all 7 factors", async () => {
    const engine = createDefaultRiskEngine();
    const ctx = createContext();

    const result = await engine.calculate(ctx);

    const factorKeys = result.factors.map((f) => f.factorKey);
    expect(factorKeys).toEqual([
      "IDENTITY_VERIFIED",
      "INCOME_VERIFIABLE",
      "DEBT_TO_INCOME",
      "LOAN_HISTORY",
      "PAYMENT_HISTORY",
      "PREVIOUS_DELINQUENCY",
      "APPLICATION_COUNT",
    ]);
  });

  it("includes reason in each factor", async () => {
    const engine = createDefaultRiskEngine();
    const ctx = createContext();

    const result = await engine.calculate(ctx);

    for (const factor of result.factors) {
      expect(factor.reason).toBeTruthy();
      expect(typeof factor.reason).toBe("string");
    }
  });

  it("score is sum of contributions", async () => {
    const engine = createDefaultRiskEngine();
    const ctx = createContext();

    const result = await engine.calculate(ctx);

    const sumContributions = result.factors.reduce((sum, f) => sum + f.contributionBps, 0);
    expect(result.score).toBe(sumContributions);
  });

  it("uses custom model version", async () => {
    const customRules = [
      { name: "Test Rule", kind: "IDENTITY_VERIFIED", weightBps: 10000, params: {} },
    ];
    const engine = new (await import("./risk-engine")).RuleBasedRiskEngine(customRules, "custom-v2.0");
    const ctx = createContext({ identityVerified: true });

    const result = await engine.calculate(ctx);

    expect(result.modelVersion).toBe("custom-v2.0");
  });

  it("handles edge case: all factors at minimum", async () => {
    const engine = createDefaultRiskEngine();
    const ctx = createContext({
      identityVerified: false,
      incomeVerifiable: false,
      debtToIncomeRatio: 1.0,
      loanHistoryCount: 0,
      paymentHistoryScore: 0,
      previousDelinquency: true,
      applicationCount: 10,
    });

    const result = await engine.calculate(ctx);

    expect(result.score).toBe(0);
    expect(result.riskLevel).toBe("HIGH");
  });

  it("handles edge case: all factors at maximum", async () => {
    const engine = createDefaultRiskEngine();
    const ctx = createContext({
      identityVerified: true,
      incomeVerifiable: true,
      debtToIncomeRatio: 0.0,
      loanHistoryCount: 5,
      paymentHistoryScore: 100,
      previousDelinquency: false,
      applicationCount: 0,
    });

    const result = await engine.calculate(ctx);

    expect(result.score).toBe(100);
    expect(result.riskLevel).toBe("LOW");
  });
});