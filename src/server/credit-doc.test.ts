import { describe, expect, it } from "vitest";
import {
  buildCreditProductDoc,
  creditProductDocSchema,
  buildProductTierDoc,
  buildUserLimitOverrideDoc,
  buildLoanApplicationDoc,
  buildSystemConfigDoc,
  systemConfigDocSchema,
  buildRiskRuleDoc,
  buildInterestRateDoc,
  buildLoanDoc,
  Currency,
  TermFrequency,
  ApplicationStatus,
} from "./credit-doc";

const NOW = new Date("2026-09-25T12:00:00.000Z");

describe("credit-doc", () => {
  describe("creditProductDocSchema", () => {
    it("crea un producto válido con campos requeridos", () => {
      const doc = buildCreditProductDoc(
        {
          name: "Microcrédito Básico",
          currency: Currency.COP,
          termInstallments: 4,
          termFrequency: TermFrequency.BIWEEKLY,
          effectiveFeeBps: 500,
          isActive: true,
        },
        NOW,
      );

      expect(doc.name).toBe("Microcrédito Básico");
      expect(doc.currency).toBe(Currency.COP);
      expect(doc.termInstallments).toBe(4);
      expect(doc.termFrequency).toBe(TermFrequency.BIWEEKLY);
      expect(doc.effectiveFeeBps).toBe(500);
      expect(doc.isActive).toBe(true);
      expect(doc.createdAt).toBe(NOW);
      expect(doc.updatedAt).toBe(NOW);
    });

    it("rechaza feeBps > 10000 (100%)", () => {
      expect(() =>
        buildCreditProductDoc(
          {
            name: "Test",
            currency: Currency.COP,
            termInstallments: 4,
            termFrequency: TermFrequency.BIWEEKLY,
            effectiveFeeBps: 10001,
          },
          NOW,
        ),
      ).toThrow();
    });

    it("rechaza termInstallments <= 0", () => {
      expect(() =>
        buildCreditProductDoc(
          {
            name: "Test",
            currency: Currency.COP,
            termInstallments: 0,
            termFrequency: TermFrequency.BIWEEKLY,
            effectiveFeeBps: 500,
          },
          NOW,
        ),
      ).toThrow();
    });

    it("asigna rango por defecto 2-6 cuando no se declara", () => {
      const doc = buildCreditProductDoc(
        { name: "Test", currency: Currency.COP, termInstallments: 4, termFrequency: TermFrequency.MONTHLY, effectiveFeeBps: 500 },
        NOW,
      );

      expect(doc.minTermInstallments).toBe(2);
      expect(doc.maxTermInstallments).toBe(6);
    });

    it("acepta un rango explícito de cuotas", () => {
      const doc = buildCreditProductDoc(
        {
          name: "Test",
          currency: Currency.COP,
          termInstallments: 3,
          termFrequency: TermFrequency.MONTHLY,
          minTermInstallments: 2,
          maxTermInstallments: 12,
          effectiveFeeBps: 500,
        },
        NOW,
      );

      expect(doc.minTermInstallments).toBe(2);
      expect(doc.maxTermInstallments).toBe(12);
    });

    it("rechaza minTermInstallments < 2", () => {
      expect(() =>
        buildCreditProductDoc(
          {
            name: "Test",
            currency: Currency.COP,
            termInstallments: 2,
            termFrequency: TermFrequency.MONTHLY,
            minTermInstallments: 1,
            maxTermInstallments: 6,
            effectiveFeeBps: 500,
          },
          NOW,
        ),
      ).toThrow();
    });

    it("rechaza maxTermInstallments < minTermInstallments", () => {
      expect(() =>
        buildCreditProductDoc(
          {
            name: "Test",
            currency: Currency.COP,
            termInstallments: 4,
            termFrequency: TermFrequency.MONTHLY,
            minTermInstallments: 4,
            maxTermInstallments: 3,
            effectiveFeeBps: 500,
          },
          NOW,
        ),
      ).toThrow(/maxTermInstallments/);
    });

    it("rechaza termInstallments fuera del rango del producto", () => {
      expect(() =>
        buildCreditProductDoc(
          {
            name: "Test",
            currency: Currency.COP,
            termInstallments: 7,
            termFrequency: TermFrequency.MONTHLY,
            minTermInstallments: 2,
            maxTermInstallments: 6,
            effectiveFeeBps: 500,
          },
          NOW,
        ),
      ).toThrow(/termInstallments/);
    });

    it("rechaza campos extra (strict)", () => {
      const input = buildCreditProductDoc(
        {
          name: "Test",
          currency: Currency.COP,
          termInstallments: 4,
          termFrequency: TermFrequency.BIWEEKLY,
          effectiveFeeBps: 500,
        },
        NOW,
      );
      expect(() => creditProductDocSchema.parse({ ...input, campoExtra: "valor" })).toThrow();
    });
  });

  describe("productTierDocSchema", () => {
    it("crea un tier válido", () => {
      const doc = buildProductTierDoc(
        {
          productCode: "MICRO_BASICO",
          position: 1,
          amountPesos: 50000,
          minScore: 60,
          isActive: true,
        },
        NOW,
      );

      expect(doc.productCode).toBe("MICRO_BASICO");
      expect(doc.position).toBe(1);
      expect(doc.amountPesos).toBe(50000);
      expect(doc.minScore).toBe(60);
      expect(doc.isActive).toBe(true);
    });

    it("minScore es opcional", () => {
      const doc = buildProductTierDoc(
        {
          productCode: "MICRO_BASICO",
          position: 2,
          amountPesos: 75000,
          isActive: true,
        },
        NOW,
      );

      expect(doc.minScore).toBeUndefined();
    });

    it("rechaza amountPesos <= 0", () => {
      expect(() =>
        buildProductTierDoc(
          {
            productCode: "TEST",
            position: 1,
            amountPesos: 0,
          },
          NOW,
        ),
      ).toThrow();
    });

    it("rechaza position <= 0", () => {
      expect(() =>
        buildProductTierDoc(
          {
            productCode: "TEST",
            position: 0,
            amountPesos: 50000,
          },
          NOW,
        ),
      ).toThrow();
    });
  });

  describe("userLimitOverrideDocSchema", () => {
    it("crea un override válido", () => {
      const doc = buildUserLimitOverrideDoc(
        {
          userId: "uid-123",
          creditLimitPesos: 100000,
          overriddenBy: "admin-uid",
          reason: "Cliente con buen historial",
          active: true,
        },
        NOW,
      );

      expect(doc.userId).toBe("uid-123");
      expect(doc.creditLimitPesos).toBe(100000);
      expect(doc.overriddenBy).toBe("admin-uid");
      expect(doc.reason).toBe("Cliente con buen historial");
      expect(doc.active).toBe(true);
    });

    it("rechaza creditLimitPesos <= 0", () => {
      expect(() =>
        buildUserLimitOverrideDoc(
          {
            userId: "uid-123",
            creditLimitPesos: -1000,
            overriddenBy: "admin-uid",
            reason: "Test",
          },
          NOW,
        ),
      ).toThrow();
    });
  });

  describe("loanApplicationDocSchema", () => {
    it("crea una solicitud en estado DRAFT por defecto", () => {
      const doc = buildLoanApplicationDoc(
        {
          applicationNumber: "APP-2026-001",
          userId: "uid-123",
          productId: "MICRO_BASICO",
          requestedAmountPesos: 50000,
          termInstallments: 4,
          termFrequency: TermFrequency.BIWEEKLY,
        },
        NOW,
      );

      expect(doc.applicationNumber).toBe("APP-2026-001");
      expect(doc.userId).toBe("uid-123");
      expect(doc.productId).toBe("MICRO_BASICO");
      expect(doc.requestedAmountPesos).toBe(50000);
      expect(doc.status).toBe(ApplicationStatus.DRAFT);
      expect(doc.decisionNotes).toBeUndefined();
      expect(doc.reviewedBy).toBeUndefined();
    });

    it("permite estado SUBMITTED", () => {
      const doc = buildLoanApplicationDoc(
        {
          applicationNumber: "APP-2026-002",
          userId: "uid-123",
          productId: "MICRO_BASICO",
          requestedAmountPesos: 50000,
          termInstallments: 4,
          termFrequency: TermFrequency.BIWEEKLY,
          status: ApplicationStatus.SUBMITTED,
        },
        NOW,
      );

      expect(doc.status).toBe(ApplicationStatus.SUBMITTED);
    });

    it("rechaza requestedAmountPesos <= 0", () => {
      expect(() =>
        buildLoanApplicationDoc(
          {
            applicationNumber: "APP-2026-003",
            userId: "uid-123",
            productId: "MICRO_BASICO",
            requestedAmountPesos: -50000,
            termInstallments: 4,
            termFrequency: TermFrequency.BIWEEKLY,
          },
          NOW,
        ),
      ).toThrow();
    });
  });

  describe("systemConfigDocSchema", () => {
    it("crea configuración válida", () => {
      const doc = buildSystemConfigDoc(
        {
          value: { dueSoonDays: 3, overdueDays: 1, defaultDays: 30 },
          updatedBy: "admin-uid",
        },
        NOW,
      );

      expect(doc.value).toEqual({ dueSoonDays: 3, overdueDays: 1, defaultDays: 30 });
      expect(doc.updatedBy).toBe("admin-uid");
    });

    it("rechaza value no objeto", () => {
      expect(() =>
        systemConfigDocSchema.parse({
          value: "no-es-objeto",
          updatedBy: "admin-uid",
          updatedAt: NOW,
        }),
      ).toThrow();
    });
  });

  describe("riskRuleDocSchema", () => {
    it("crea una regla de riesgo válida", () => {
      const doc = buildRiskRuleDoc(
        {
          name: "Capacidad de pago",
          kind: "DEBT_TO_INCOME",
          params: { maxRatio: 0.4 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
        },
        NOW,
      );

      expect(doc.name).toBe("Capacidad de pago");
      expect(doc.kind).toBe("DEBT_TO_INCOME");
      expect(doc.params).toEqual({ maxRatio: 0.4 });
      expect(doc.version).toBe(1);
      expect(doc.isActive).toBe(true);
    });

    it("effectiveFrom y effectiveTo son opcionales", () => {
      const doc = buildRiskRuleDoc(
        {
          name: "Regla temporal",
          kind: "TEMPORAL",
          params: {},
          version: 1,
          source: "TEST",
          effectiveFrom: NOW,
        },
        NOW,
      );

      expect(doc.effectiveFrom).toBe(NOW);
      expect(doc.effectiveTo).toBeUndefined();
    });
  });

  describe("interestRateDocSchema", () => {
    it("crea una tasa de interés válida", () => {
      const doc = buildInterestRateDoc(
        {
          productType: "MICRO_BASICO",
          annualRateBps: 2400,
          effectiveFrom: NOW,
          source: "PENDING_LEGAL_REVIEW",
          version: 1,
        },
        NOW,
      );

      expect(doc.productType).toBe("MICRO_BASICO");
      expect(doc.annualRateBps).toBe(2400);
      expect(doc.source).toBe("PENDING_LEGAL_REVIEW");
      expect(doc.version).toBe(1);
    });

    it("maximumRateBps es opcional", () => {
      const doc = buildInterestRateDoc(
        {
          productType: "MICRO_BASICO",
          annualRateBps: 2400,
          maximumRateBps: 3600,
          effectiveFrom: NOW,
          source: "LEGAL_APROBADO",
          version: 1,
        },
        NOW,
      );

      expect(doc.maximumRateBps).toBe(3600);
    });
  });

  describe("buildLoanDoc", () => {
    const pricing = {
      annualRateBps: 2400,
      effectiveFeeBps: 500,
      rateVersion: 1,
      termInstallments: 4,
      termFrequency: TermFrequency.BIWEEKLY,
    };

    const baseInput = {
      loanNumber: "LOAN-2026-0001",
      applicationId: "APP-2026-0001",
      userId: "uid-1",
      productCode: "MICRO_BASICO",
      principalPesos: 50_000,
      interestPesos: 1_505,
      feePesos: 2_500,
      pricing,
    };

    function build(overrides: Partial<Parameters<typeof buildLoanDoc>[0]> = {}) {
      return buildLoanDoc({ ...baseInput, ...overrides }, NOW);
    }

    it("congela la base de cálculo en el doc", () => {
      const doc = build();

      expect(doc.pricing).toEqual(pricing);
      expect(doc.totalPayablePesos).toBe(54_005);
    });

    it("exige el snapshot: un préstamo sin base de cálculo no es válido", () => {
      const sinPricing = { ...baseInput } as Record<string, unknown>;
      delete sinPricing.pricing;

      expect(() => buildLoanDoc(sinPricing as unknown as Parameters<typeof buildLoanDoc>[0], NOW)).toThrow();
    });

    it("rechaza un snapshot incompleto o con campos extra", () => {
      const incompleto = {
        annualRateBps: 2400,
        effectiveFeeBps: 500,
        termInstallments: 4,
        termFrequency: TermFrequency.BIWEEKLY,
      };

      expect(() => build({ pricing: incompleto as never })).toThrow();
      expect(() => build({ pricing: { ...pricing, campoExtra: 1 } as never })).toThrow();
    });

    it("rechaza un snapshot con tasa o plazo imposibles", () => {
      expect(() => build({ pricing: { ...pricing, annualRateBps: -1 } })).toThrow();
      expect(() => build({ pricing: { ...pricing, termInstallments: 0 } })).toThrow();
      expect(() => build({ pricing: { ...pricing, rateVersion: 0 } })).toThrow();
    });
  });
});