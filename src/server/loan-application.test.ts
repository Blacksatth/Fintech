import { describe, expect, it } from "vitest";
import {
  findEligibleTier,
  validateApplicationAmount,
  validateApplicationTerm,
  createLoanApplicationDraft,
  submitLoanApplication,
  generateApplicationNumber,
} from "./loan-application";
import { ApplicationStatus, CreditProductDoc, ProductTierDoc, LoanApplicationDoc } from "./credit-doc";

const NOW = new Date("2026-09-25T12:00:00.000Z");

const mockProduct: CreditProductDoc & { code: string } = {
  code: "MICRO_BASICO",
  name: "Microcrédito Básico",
  currency: "COP",
  termInstallments: 4,
  termFrequency: "MONTHLY",
  minTermInstallments: 2,
  maxTermInstallments: 6,
  effectiveFeeBps: 0,
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
};

const mockTiers: ProductTierDoc[] = [
  { productCode: "MICRO_BASICO", position: 1, amountPesos: 50000, minScore: 60, isActive: true, createdAt: NOW, updatedAt: NOW },
  { productCode: "MICRO_BASICO", position: 2, amountPesos: 75000, minScore: 65, isActive: true, createdAt: NOW, updatedAt: NOW },
  { productCode: "MICRO_BASICO", position: 3, amountPesos: 100000, minScore: 70, isActive: true, createdAt: NOW, updatedAt: NOW },
];

describe("loan-application domain", () => {
  describe("generateApplicationNumber", () => {
    it("genera número con formato correcto", () => {
      const num = generateApplicationNumber();
      expect(num).toMatch(/^APP-\d{4}-\d{4}$/);
    });
  });

  describe("findEligibleTier", () => {
    it("retorna tier 1 para usuario sin historial", () => {
      const history = { completedLoans: 0, activeLoans: 0, defaultedLoans: 0 };
      const result = findEligibleTier("uid-1", mockProduct, mockTiers, history, "MICRO_BASICO");

      expect(result.canApply).toBe(true);
      expect(result.tier?.position).toBe(1);
      expect(result.tier?.amountPesos).toBe(50000);
    });

    it("retorna tier 2 para usuario con 1 préstamo pagado", () => {
      const history = { completedLoans: 1, activeLoans: 0, defaultedLoans: 0 };
      const result = findEligibleTier("uid-1", mockProduct, mockTiers, history, "MICRO_BASICO");

      expect(result.canApply).toBe(true);
      expect(result.tier?.position).toBe(2);
      expect(result.tier?.amountPesos).toBe(75000);
    });

    it("retorna tier 3 para usuario con 2 préstamos pagados", () => {
      const history = { completedLoans: 2, activeLoans: 0, defaultedLoans: 0 };
      const result = findEligibleTier("uid-1", mockProduct, mockTiers, history, "MICRO_BASICO");

      expect(result.canApply).toBe(true);
      expect(result.tier?.position).toBe(3);
      expect(result.tier?.amountPesos).toBe(100000);
    });

    it("bloquea si tiene préstamo activo", () => {
      const history = { completedLoans: 0, activeLoans: 1, defaultedLoans: 0 };
      const result = findEligibleTier("uid-1", mockProduct, mockTiers, history, "MICRO_BASICO");

      expect(result.canApply).toBe(false);
      expect(result.reason).toContain("préstamo activo");
    });

    it("reduce tier si tiene préstamo incumplido", () => {
      const history = { completedLoans: 2, activeLoans: 0, defaultedLoans: 1 };
      const result = findEligibleTier("uid-1", mockProduct, mockTiers, history, "MICRO_BASICO");

      expect(result.canApply).toBe(true);
      expect(result.tier?.position).toBe(2);
    });

    it("no reduce tier 1 aunque tenga incumplido", () => {
      const history = { completedLoans: 0, activeLoans: 0, defaultedLoans: 1 };
      const result = findEligibleTier("uid-1", mockProduct, mockTiers, history, "MICRO_BASICO");

      expect(result.canApply).toBe(true);
      expect(result.tier?.position).toBe(1);
    });

    it("retorna no elegible si no hay tiers activos", () => {
      const result = findEligibleTier("uid-1", mockProduct, [], { completedLoans: 0, activeLoans: 0, defaultedLoans: 0 }, "MICRO_BASICO");

      expect(result.canApply).toBe(false);
      expect(result.reason).toContain("tiers activos");
    });

    describe("con límite de crédito por usuario (F13-2)", () => {
      const history = { completedLoans: 2, activeLoans: 0, defaultedLoans: 0 };

      it("baja al mayor tier cuyo monto cabe en el límite", () => {
        const result = findEligibleTier("uid-1", mockProduct, mockTiers, history, "MICRO_BASICO", 75000);

        expect(result.canApply).toBe(true);
        expect(result.tier?.position).toBe(2);
        expect(result.tier?.amountPesos).toBe(75000);
      });

      it("deja el tier intacto si el límite alcanza su monto", () => {
        const result = findEligibleTier("uid-1", mockProduct, mockTiers, history, "MICRO_BASICO", 100000);

        expect(result.canApply).toBe(true);
        expect(result.tier?.position).toBe(3);
      });

      it("no es elegible si el límite es menor que el monto mínimo del producto", () => {
        const result = findEligibleTier("uid-1", mockProduct, mockTiers, history, "MICRO_BASICO", 40000);

        expect(result.canApply).toBe(false);
        expect(result.reason).toContain("límite");
      });

      it("el límite exacto al monto mínimo permite pedir ese monto", () => {
        const result = findEligibleTier("uid-1", mockProduct, mockTiers, history, "MICRO_BASICO", 50000);

        expect(result.canApply).toBe(true);
        expect(result.tier?.position).toBe(1);
        expect(result.tier?.amountPesos).toBe(50000);
      });

      it("baja también el tier reducido por incumplimiento", () => {
        const solid = { completedLoans: 2, activeLoans: 0, defaultedLoans: 1 };
        const result = findEligibleTier("uid-1", mockProduct, mockTiers, solid, "MICRO_BASICO", 50000);

        expect(result.canApply).toBe(true);
        expect(result.tier?.position).toBe(1);
      });

      it("ignora tiers inactivos al buscar el que cabe en el límite", () => {
        const withInactive = [...mockTiers, { ...mockTiers[2], position: 3, amountPesos: 90000, isActive: false }];
        const result = findEligibleTier("uid-1", mockProduct, withInactive, history, "MICRO_BASICO", 90000);

        expect(result.canApply).toBe(true);
        expect(result.tier?.position).toBe(2);
        expect(result.tier?.amountPesos).toBe(75000);
      });
    });
  });

  describe("validateApplicationAmount", () => {
    it("acepta monto exacto del tier", () => {
      const tier = mockTiers[0];
      const result = validateApplicationAmount(50000, tier);

      expect(result.valid).toBe(true);
    });

    it("rechaza monto diferente al tier", () => {
      const tier = mockTiers[0];
      const result = validateApplicationAmount(60000, tier);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("no coincide");
    });

    it("rechaza si no hay tier", () => {
      const result = validateApplicationAmount(50000, null);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("No hay tier elegible");
    });
  });

  describe("validateApplicationTerm", () => {
    it("acepta un plazo dentro del rango con la frecuencia del producto", () => {
      const result = validateApplicationTerm(mockProduct, 3, "MONTHLY", (f) => f);

      expect(result.valid).toBe(true);
    });

    it("acepta el mínimo de cuotas (2)", () => {
      const result = validateApplicationTerm(mockProduct, 2, "MONTHLY", (f) => f);

      expect(result.valid).toBe(true);
    });

    it("rechaza 1 cuota (mínimo es 2)", () => {
      const result = validateApplicationTerm(mockProduct, 1, "MONTHLY", (f) => f);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("2");
    });

    it("rechaza más cuotas que el máximo del producto", () => {
      const result = validateApplicationTerm(mockProduct, 7, "MONTHLY", (f) => f);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("6");
    });

    it("rechaza una frecuencia distinta a la del producto", () => {
      const result = validateApplicationTerm(mockProduct, 4, "BIWEEKLY", (f) => f);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("frecuencia");
    });

    it("usa el rango por defecto si el producto no lo declara (docs legados)", () => {
      const legacy = { ...mockProduct, minTermInstallments: undefined, maxTermInstallments: undefined } as unknown as Pick<
        typeof mockProduct,
        "termFrequency" | "minTermInstallments" | "maxTermInstallments"
      >;

      expect(validateApplicationTerm(legacy, 5, "MONTHLY", (f) => f).valid).toBe(true);
      expect(validateApplicationTerm(legacy, 1, "MONTHLY", (f) => f).valid).toBe(false);
    });
  });

  describe("createLoanApplicationDraft", () => {
    it("crea borrador con campos correctos", () => {
      const tier = mockTiers[0];
      const draft = createLoanApplicationDraft(
        { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
        mockProduct,
        tier,
        NOW,
      );

      expect(draft.userId).toBe("uid-1");
      expect(draft.productId).toBe("MICRO_BASICO");
      expect(draft.requestedAmountPesos).toBe(50000);
      expect(draft.termInstallments).toBe(4);
      expect(draft.termFrequency).toBe("MONTHLY");
      expect(draft.status).toBe(ApplicationStatus.DRAFT);
      expect(draft.applicationNumber).toMatch(/^APP-\d{4}-\d{4}$/);
      expect(draft.createdAt).toBe(NOW);
      expect(draft.updatedAt).toBe(NOW);
    });

    it("lanza si el plazo queda fuera del rango del producto", () => {
      const tier = mockTiers[0];
      expect(() =>
        createLoanApplicationDraft(
          { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 1, termFrequency: "MONTHLY" },
          mockProduct,
          tier,
          NOW,
        ),
      ).toThrow(/2 a 6/);
    });

    it("lanza si la frecuencia no es la del producto", () => {
      const tier = mockTiers[0];
      expect(() =>
        createLoanApplicationDraft(
          { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "BIWEEKLY" },
          mockProduct,
          tier,
          NOW,
        ),
      ).toThrow(/frecuencia/);
    });
  });

  describe("submitLoanApplication", () => {
    it("cambia estado DRAFT a SUBMITTED", () => {
      const draft: LoanApplicationDoc = {
        applicationNumber: "APP-2026-0001",
        userId: "uid-1",
        productId: "MICRO_BASICO",
        requestedAmountPesos: 50000,
        termInstallments: 4,
        termFrequency: "BIWEEKLY",
        status: ApplicationStatus.DRAFT,
        createdAt: NOW,
        updatedAt: NOW,
      };

      const submitted = submitLoanApplication(draft, NOW);

      expect(submitted.status).toBe(ApplicationStatus.SUBMITTED);
      expect(submitted.updatedAt).toBe(NOW);
      expect(submitted.applicationNumber).toBe(draft.applicationNumber);
    });

    it("lanza error si no está en DRAFT", () => {
      const draft: LoanApplicationDoc = {
        applicationNumber: "APP-2026-0001",
        userId: "uid-1",
        productId: "MICRO_BASICO",
        requestedAmountPesos: 50000,
        termInstallments: 4,
        termFrequency: "BIWEEKLY",
        status: ApplicationStatus.SUBMITTED,
        createdAt: NOW,
        updatedAt: NOW,
      };

      expect(() => submitLoanApplication(draft, NOW)).toThrow("Solo se puede presentar una solicitud en estado DRAFT");
    });
  });
});