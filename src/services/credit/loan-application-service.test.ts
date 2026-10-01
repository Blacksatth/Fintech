import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  createLoanApplication,
  submitLoanApplicationService,
  getLoanApplication,
  getLoanApplicationForUser,
  listLoanApplications,
} from "./loan-application-service";
import { ApplicationStatus, CreditProductDoc, ProductTierDoc, LoanApplicationDoc } from "@/server/credit-doc";
import { createFirestoreMock, InMemoryFirestore } from "@/test-utils/firestore-mock";

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

const mockTiers: (ProductTierDoc & { id: string })[] = [
  { id: "MICRO_BASICO_1", productCode: "MICRO_BASICO", position: 1, amountPesos: 50000, minScore: 60, isActive: true, createdAt: NOW, updatedAt: NOW },
  { id: "MICRO_BASICO_2", productCode: "MICRO_BASICO", position: 2, amountPesos: 75000, minScore: 65, isActive: true, createdAt: NOW, updatedAt: NOW },
  { id: "MICRO_BASICO_3", productCode: "MICRO_BASICO", position: 3, amountPesos: 100000, minScore: 70, isActive: true, createdAt: NOW, updatedAt: NOW },
];

/** Doc de `loans`: el servicio solo lee `userId` y `status` para el historial. */
interface MockLoanDoc {
  userId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

function loan(status: string, userId = "uid-1"): MockLoanDoc {
  return { userId, status, createdAt: NOW, updatedAt: NOW };
}

function applicationDoc(overrides: Partial<LoanApplicationDoc> = {}): LoanApplicationDoc {
  return {
    applicationNumber: "APP-2026-0001",
    userId: "uid-1",
    productId: "MICRO_BASICO",
    requestedAmountPesos: 50000,
    termInstallments: 4,
    termFrequency: "MONTHLY",
    status: ApplicationStatus.DRAFT,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function setup(options: {
  product?: CreditProductDoc & { code: string };
  tiers?: (ProductTierDoc & { id: string })[];
  loans?: MockLoanDoc[];
  applications?: Record<string, LoanApplicationDoc>;
} = {}): { db: Firestore; store: InMemoryFirestore } {
  const { store, db } = createFirestoreMock();

  const product = options.product ?? mockProduct;
  const tiers = options.tiers ?? mockTiers;

  store.seed("credit_products", product.code, { ...product });
  for (const tier of tiers) {
    store.seed("product_tiers", tier.id, { ...tier });
  }
  for (const [index, item] of (options.loans ?? []).entries()) {
    store.seed("loans", `loan-${index + 1}`, { ...item });
  }
  for (const [id, app] of Object.entries(options.applications ?? {})) {
    store.seed("loan_applications", id, { ...app });
  }

  return { db, store };
}

describe("loan-application-service", () => {
  describe("createLoanApplication", () => {
    it("crea borrador para usuario sin historial", async () => {
      const { db } = setup();

      const result = await createLoanApplication(
        { db },
        { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
      );

      expect(result.application.userId).toBe("uid-1");
      expect(result.application.requestedAmountPesos).toBe(50000);
      expect(result.application.status).toBe(ApplicationStatus.DRAFT);
      expect(result.eligibleTier.tier?.position).toBe(1);
    });

    it("crea borrador para usuario con 1 préstamo pagado (tier 2)", async () => {
      const { db } = setup({ loans: [loan("PAID")] });

      const result = await createLoanApplication(
        { db },
        { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 75000, termInstallments: 4, termFrequency: "MONTHLY" },
      );

      expect(result.eligibleTier.tier?.position).toBe(2);
      expect(result.application.requestedAmountPesos).toBe(75000);
    });

    it("lanza error si monto no coincide con tier", async () => {
      const { db } = setup();

      await expect(
        createLoanApplication(
          { db },
          { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 60000, termInstallments: 4, termFrequency: "MONTHLY" },
        ),
      ).rejects.toThrow("no coincide");
    });

    it("lanza error si usuario tiene préstamo activo", async () => {
      const { db } = setup({ loans: [loan("DISBURSED")] });

      await expect(
        createLoanApplication(
          { db },
          { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
        ),
      ).rejects.toThrow("préstamo activo");
    });

    it("lanza error si producto inactivo", async () => {
      const { db } = setup({ product: { ...mockProduct, isActive: false } });

      await expect(
        createLoanApplication(
          { db },
          { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
        ),
      ).rejects.toThrow("Producto no encontrado o inactivo");
    });

    it("reduce tier si tiene préstamo incumplido", async () => {
      // 1 préstamo pagado habilita el tier 2, pero el incumplimiento lo reduce al tier 1.
      const { db } = setup({ loans: [loan("DEFAULTED"), loan("PAID")] });

      const result = await createLoanApplication(
        { db },
        { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
      );

      expect(result.eligibleTier.tier?.position).toBe(1);
      expect(result.application.requestedAmountPesos).toBe(50000);
    });

    it("rechaza el monto del tier no reducido cuando hay incumplimiento", async () => {
      const { db } = setup({ loans: [loan("DEFAULTED"), loan("PAID")] });

      await expect(
        createLoanApplication(
          { db },
          { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 75000, termInstallments: 4, termFrequency: "MONTHLY" },
        ),
      ).rejects.toThrow("no coincide con el tier elegible (50000)");
    });

    describe("con límite de crédito por usuario (F13-2)", () => {
      function seedOverride(store: InMemoryFirestore, uid: string, creditLimitPesos: number) {
        store.seed("user_limit_overrides", uid, {
          userId: uid,
          creditLimitPesos,
          overriddenBy: "admin-1",
          reason: "Límite aprobado",
          active: true,
          createdAt: NOW,
        });
      }

      it("baja el tier al mayor monto que cabe en el límite", async () => {
        const { store, db } = setup({ loans: [loan("PAID"), loan("PAID")] });
        seedOverride(store, "uid-1", 75000);

        const result = await createLoanApplication(
          { db },
          { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 75000, termInstallments: 4, termFrequency: "MONTHLY" },
        );

        expect(result.eligibleTier.tier?.position).toBe(2);
        expect(result.eligibleTier.tier?.amountPesos).toBe(75000);
      });

      it("mantiene el tier si el límite alcanza su monto", async () => {
        const { store, db } = setup({ loans: [loan("PAID"), loan("PAID")] });
        seedOverride(store, "uid-1", 100000);

        const result = await createLoanApplication(
          { db },
          { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 100000, termInstallments: 4, termFrequency: "MONTHLY" },
        );

        expect(result.eligibleTier.tier?.position).toBe(3);
      });

      it("bloquea la solicitud si el límite no alcanza el monto mínimo", async () => {
        const { store, db } = setup({ loans: [loan("PAID"), loan("PAID")] });
        seedOverride(store, "uid-1", 40000);

        await expect(
          createLoanApplication(
            { db },
            { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
          ),
        ).rejects.toThrow("límite");
      });

      it("ignora un override inactivo", async () => {
        const { store, db } = setup({ loans: [loan("PAID"), loan("PAID")] });
        store.seed("user_limit_overrides", "uid-1", {
          userId: "uid-1",
          creditLimitPesos: 1000,
          overriddenBy: "admin-1",
          reason: "Revocado",
          active: false,
          createdAt: NOW,
        });

        const result = await createLoanApplication(
          { db },
          { userId: "uid-1", productId: "MICRO_BASICO", requestedAmountPesos: 100000, termInstallments: 4, termFrequency: "MONTHLY" },
        );

        expect(result.eligibleTier.tier?.position).toBe(3);
      });
    });
  });

  describe("submitLoanApplicationService", () => {
    it("presenta solicitud en DRAFT y guarda el score", async () => {
      const { db, store } = setup({ applications: { "app-1": applicationDoc() } });

      const submitted = await submitLoanApplicationService({ db }, "app-1", "uid-1");

      expect(submitted.status).toBe(ApplicationStatus.SUBMITTED);
      expect(store.read("loan_applications", "app-1")?.status).toBe(ApplicationStatus.SUBMITTED);
      expect(store.read("credit_scores", "app-1")).toBeDefined();
    });

    it("lanza error si no existe", async () => {
      const { db } = setup();

      await expect(submitLoanApplicationService({ db }, "no-existe", "uid-1")).rejects.toThrow("Solicitud no encontrada");
    });

    it("lanza 404 si no es del usuario, indistinguible de que no exista", async () => {
      const { db } = setup({ applications: { "app-1": applicationDoc({ userId: "uid-2" }) } });

      const ajeno = await submitLoanApplicationService({ db }, "app-1", "uid-1").catch((e: unknown) => e);
      const inexistente = await submitLoanApplicationService({ db }, "no-existe", "uid-1").catch(
        (e: unknown) => e,
      );

      expect((ajeno as { statusCode?: number }).statusCode).toBe(404);
      expect((ajeno as Error).message).toBe((inexistente as Error).message);
    });

    it("lanza error si ya no está en DRAFT", async () => {
      const { db } = setup({ applications: { "app-1": applicationDoc({ status: ApplicationStatus.SUBMITTED }) } });

      await expect(submitLoanApplicationService({ db }, "app-1", "uid-1")).rejects.toThrow(
        "Solo se puede presentar una solicitud en estado DRAFT",
      );
    });
  });

  describe("getLoanApplication", () => {
    it("retorna solicitud si existe", async () => {
      const { db } = setup({ applications: { "app-1": applicationDoc() } });

      const result = await getLoanApplication({ db }, "app-1");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("app-1");
      expect(result?.applicationNumber).toBe("APP-2026-0001");
    });

    it("retorna null si no existe", async () => {
      const { db } = setup();

      const result = await getLoanApplication({ db }, "no-existe");

      expect(result).toBeNull();
    });
  });

  describe("getLoanApplicationForUser", () => {
    it("retorna la solicitud del propio usuario", async () => {
      const { db } = setup({ applications: { "app-1": applicationDoc() } });

      const result = await getLoanApplicationForUser({ db }, "uid-1", "app-1");

      expect(result.id).toBe("app-1");
    });

    it("da 404 si la solicitud es de otro usuario", async () => {
      const { db } = setup({ applications: { "app-1": applicationDoc({ userId: "uid-2" }) } });

      await expect(getLoanApplicationForUser({ db }, "uid-1", "app-1")).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("el 404 es identico si es ajena o si no existe", async () => {
      const { db } = setup({ applications: { "app-1": applicationDoc({ userId: "uid-2" }) } });

      const ajeno = await getLoanApplicationForUser({ db }, "uid-1", "app-1").catch((e: unknown) => e);
      const inexistente = await getLoanApplicationForUser({ db }, "uid-1", "no-existe").catch(
        (e: unknown) => e,
      );

      expect((ajeno as Error).message).toBe((inexistente as Error).message);
      expect((ajeno as { statusCode?: number }).statusCode).toBe(
        (inexistente as { statusCode?: number }).statusCode,
      );
    });
  });

  describe("listLoanApplications", () => {
    it("lista solicitudes del usuario ordenadas por createdAt desc", async () => {
      const { db } = setup({
        applications: {
          "app-1": applicationDoc({ applicationNumber: "APP-2026-0001", createdAt: NOW }),
          "app-2": applicationDoc({ applicationNumber: "APP-2026-0002", createdAt: new Date("2026-09-26T12:00:00.000Z") }),
          "app-3": applicationDoc({ applicationNumber: "APP-2026-0003", userId: "otro-uid" }),
        },
      });

      const result = await listLoanApplications({ db }, "uid-1");

      expect(result).toHaveLength(2);
      expect(result[0].applicationNumber).toBe("APP-2026-0002");
      expect(result[1].applicationNumber).toBe("APP-2026-0001");
    });

    it("retorna vacío si no hay solicitudes", async () => {
      const { db } = setup();

      const result = await listLoanApplications({ db }, "uid-1");

      expect(result).toEqual([]);
    });
  });
});
