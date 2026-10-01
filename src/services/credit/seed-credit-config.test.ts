import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { seedCreditConfig } from "./seed-credit-config";

function fakeDb(existingDocs: Record<string, Record<string, Record<string, unknown>>> = {}): Firestore {
  const store = new Map<string, Record<string, unknown>>();
  for (const [collection, docs] of Object.entries(existingDocs)) {
    for (const [id, data] of Object.entries(docs)) {
      store.set(`${collection}/${id}`, data);
    }
  }
  return {
    collection: vi.fn((name: string) => ({
      doc: vi.fn((id: string) => ({
        get: vi.fn(async () => {
          const key = `${name}/${id}`;
          if (store.has(key)) {
            return { exists: true, data: () => store.get(key) };
          }
          return { exists: false };
        }),
        set: vi.fn(async (data: Record<string, unknown>) => {
          const key = `${name}/${id}`;
          store.set(key, data);
        }),
        update: vi.fn(async (data: Record<string, unknown>) => {
          const key = `${name}/${id}`;
          store.set(key, { ...(store.get(key) ?? {}), ...data });
        }),
      })),
    })),
  } as unknown as Firestore;
}

describe("seedCreditConfig", () => {
  it("crea producto, tiers y config por defecto", async () => {
    const db = fakeDb();
    const result = await seedCreditConfig(db);

    expect(result.productCode).toBe("MICRO_BASICO");
    expect(result.tiersCreated).toBe(3);
    expect(result.configCreated.length).toBeGreaterThan(0);

    expect(result.configCreated).toContain("credit_products/MICRO_BASICO");
    expect(result.configCreated).toContain("product_tiers/MICRO_BASICO_1");
    expect(result.configCreated).toContain("product_tiers/MICRO_BASICO_2");
    expect(result.configCreated).toContain("product_tiers/MICRO_BASICO_3");
    expect(result.configCreated).toContain("system_config/delinquency");
    expect(result.configCreated).toContain("system_config/scoring");
    expect(result.configCreated).toContain("system_config/session");
    expect(result.configCreated).toContain("system_config/loan");
    expect(result.configCreated).toContain("risk_rules/risk_identity_verified_v1");
    expect(result.configCreated).toContain("risk_rules/risk_income_verifiable_v1");
    expect(result.configCreated).toContain("risk_rules/risk_debt_to_income_v1");
    expect(result.configCreated).toContain("risk_rules/risk_loan_history_v1");
    expect(result.configCreated).toContain("risk_rules/risk_payment_history_v1");
    expect(result.configCreated).toContain("risk_rules/risk_previous_delinquency_v1");
    expect(result.configCreated).toContain("interest_rates/MICRO_BASICO_v1");
  });

  it("es idempotente: no duplica si todo existe", async () => {
    const now = new Date("2026-09-25T12:00:00.000Z");
    const existingProduct = {
      name: "Microcrédito Básico",
      currency: "COP",
      termInstallments: 4,
      termFrequency: "MONTHLY",
      minTermInstallments: 2,
      maxTermInstallments: 6,
      effectiveFeeBps: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const db = fakeDb({
      credit_products: { MICRO_BASICO: existingProduct },
      product_tiers: {
        MICRO_BASICO_1: {
          productCode: "MICRO_BASICO",
          position: 1,
          amountPesos: 50000,
          minScore: 60,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        MICRO_BASICO_2: {
          productCode: "MICRO_BASICO",
          position: 2,
          amountPesos: 75000,
          minScore: 65,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        MICRO_BASICO_3: {
          productCode: "MICRO_BASICO",
          position: 3,
          amountPesos: 100000,
          minScore: 70,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      },
      system_config: {
        delinquency: {
          value: { dueSoonDays: 3, overdueDays: 1, defaultDays: 30 },
          updatedBy: "SEED",
          updatedAt: now,
        },
        scoring: {
          value: { minScoreForTier1: 60, minScoreForTier2: 65, minScoreForTier3: 70 },
          updatedBy: "SEED",
          updatedAt: now,
        },
        session: {
          value: { maxAgeDays: 5 },
          updatedBy: "SEED",
          updatedAt: now,
        },
        loan: {
          value: { maxActiveLoansPerUser: 1 },
          updatedBy: "SEED",
          updatedAt: now,
        },
      },
      risk_rules: {
        risk_identity_verified_v1: {
          name: "Identidad verificada",
          kind: "IDENTITY_VERIFIED",
          params: { weightBps: 1500 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
        risk_income_verifiable_v1: {
          name: "Ingresos verificables",
          kind: "INCOME_VERIFIABLE",
          params: { weightBps: 2000 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
        risk_debt_to_income_v1: {
          name: "Capacidad de pago",
          kind: "DEBT_TO_INCOME",
          params: { maxRatio: 0.4, weightBps: 2500 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
        risk_loan_history_v1: {
          name: "Historial de préstamos",
          kind: "LOAN_HISTORY",
          params: { weightBps: 1500 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
        risk_payment_history_v1: {
          name: "Historial de pagos",
          kind: "PAYMENT_HISTORY",
          params: { weightBps: 1500 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
        risk_previous_delinquency_v1: {
          name: "Moras previas",
          kind: "PREVIOUS_DELINQUENCY",
          params: { weightBps: 1000 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
      },
      interest_rates: {
        MICRO_BASICO_v1: {
          productType: "MICRO_BASICO",
          annualRateBps: 0,
          effectiveFrom: now,
          source: "PENDING_LEGAL_REVIEW",
          version: 1,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    });

    const result = await seedCreditConfig(db);

    expect(result.tiersCreated).toBe(0);
    expect(result.configCreated).toEqual([]);
  });

  it("solo crea tiers faltantes", async () => {
    const now = new Date("2026-09-25T12:00:00.000Z");
    const db = fakeDb({
      product_tiers: {
        MICRO_BASICO_1: {
          productCode: "MICRO_BASICO",
          position: 1,
          amountPesos: 50000,
          minScore: 60,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    });

    const result = await seedCreditConfig(db);

    expect(result.tiersCreated).toBe(2);
  });

  it("migra un producto legado sin rango a mensual 2-6 (upgrade aditivo)", async () => {
    const now = new Date("2026-09-25T12:00:00.000Z");
    const legacyProduct = {
      name: "Microcrédito Básico",
      currency: "COP",
      termInstallments: 4,
      termFrequency: "BIWEEKLY",
      effectiveFeeBps: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const db = fakeDb({
      credit_products: { MICRO_BASICO: legacyProduct },
      product_tiers: {
        MICRO_BASICO_1: {
          productCode: "MICRO_BASICO",
          position: 1,
          amountPesos: 50000,
          minScore: 60,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        MICRO_BASICO_2: {
          productCode: "MICRO_BASICO",
          position: 2,
          amountPesos: 75000,
          minScore: 65,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        MICRO_BASICO_3: {
          productCode: "MICRO_BASICO",
          position: 3,
          amountPesos: 100000,
          minScore: 70,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      },
      system_config: {
        delinquency: {
          value: { dueSoonDays: 3, overdueDays: 1, defaultDays: 30 },
          updatedBy: "SEED",
          updatedAt: now,
        },
        scoring: {
          value: { minScoreForTier1: 60, minScoreForTier2: 65, minScoreForTier3: 70 },
          updatedBy: "SEED",
          updatedAt: now,
        },
        session: {
          value: { maxAgeDays: 5 },
          updatedBy: "SEED",
          updatedAt: now,
        },
        loan: {
          value: { maxActiveLoansPerUser: 1 },
          updatedBy: "SEED",
          updatedAt: now,
        },
      },
      risk_rules: {
        risk_identity_verified_v1: {
          name: "Identidad verificada",
          kind: "IDENTITY_VERIFIED",
          params: { weightBps: 1500 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
        risk_income_verifiable_v1: {
          name: "Ingresos verificables",
          kind: "INCOME_VERIFIABLE",
          params: { weightBps: 2000 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
        risk_debt_to_income_v1: {
          name: "Capacidad de pago",
          kind: "DEBT_TO_INCOME",
          params: { maxRatio: 0.4, weightBps: 2500 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
        risk_loan_history_v1: {
          name: "Historial de préstamos",
          kind: "LOAN_HISTORY",
          params: { weightBps: 1500 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
        risk_payment_history_v1: {
          name: "Historial de pagos",
          kind: "PAYMENT_HISTORY",
          params: { weightBps: 1500 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
        risk_previous_delinquency_v1: {
          name: "Moras previas",
          kind: "PREVIOUS_DELINQUENCY",
          params: { weightBps: 1000 },
          version: 1,
          isActive: true,
          source: "POLITICA_CREDITO_V1",
          createdAt: now,
          updatedAt: now,
        },
      },
      interest_rates: {
        MICRO_BASICO_v1: {
          productType: "MICRO_BASICO",
          annualRateBps: 0,
          effectiveFrom: now,
          source: "PENDING_LEGAL_REVIEW",
          version: 1,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    });

    const result = await seedCreditConfig(db);

    expect(result.configCreated).toContain("credit_products/MICRO_BASICO (upgrade)");
    expect(result.tiersCreated).toBe(0);
  });
});