import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createFirestoreMock, InMemoryFirestore } from "@/test-utils/firestore-mock";
import { buildCreditProductDoc, buildProductTierDoc, buildInterestRateDoc, Currency } from "@/server/credit-doc";
import { TermFrequency } from "@/server/types";
import { buildLoanSchedule, periodsPerYear } from "@/server/schedule";
import { quoteLoanPlan } from "./credit-product-quote-service";

const NOW = new Date("2026-09-25T12:00:00.000Z");

function setup(
  options: { annualRateBps?: number; effectiveFeeBps?: number; frequency?: TermFrequency } = {},
): { db: Firestore; store: InMemoryFirestore } {
  const { store, db } = createFirestoreMock();
  const frequency = options.frequency ?? TermFrequency.MONTHLY;

  store.seed(
    "credit_products",
    "MICRO_BASICO",
    {
      ...buildCreditProductDoc(
        {
          name: "Microcrédito Básico",
          currency: Currency.COP,
          termInstallments: 4,
          termFrequency: frequency,
          minTermInstallments: 2,
          maxTermInstallments: 6,
          effectiveFeeBps: options.effectiveFeeBps ?? 0,
        },
        NOW,
      ),
    },
  );
  store.seed("product_tiers", "MICRO_BASICO_1", { ...buildProductTierDoc({ productCode: "MICRO_BASICO", position: 1, amountPesos: 50000, minScore: 60 }, NOW) });
  store.seed("product_tiers", "MICRO_BASICO_2", { ...buildProductTierDoc({ productCode: "MICRO_BASICO", position: 2, amountPesos: 75000, minScore: 65 }, NOW) });
  store.seed("product_tiers", "MICRO_BASICO_3", { ...buildProductTierDoc({ productCode: "MICRO_BASICO", position: 3, amountPesos: 100000, minScore: 70 }, NOW) });
  store.seed(
    "interest_rates",
    "MICRO_BASICO_v1",
    {
      ...buildInterestRateDoc(
        { productType: "MICRO_BASICO", annualRateBps: options.annualRateBps ?? 0, effectiveFrom: new Date("2026-01-01"), source: "TEST", version: 1 },
        NOW,
      ),
    },
  );

  return { db, store };
}

describe("credit-product-quote-service", () => {
  it("cotiza el plan mensual con los pesos exactos del schedule", async () => {
    const { db } = setup();

    const quote = await quoteLoanPlan(db, { productId: "MICRO_BASICO", amountPesos: 50000, termInstallments: 4 }, NOW);

    expect(quote.termFrequency).toBe(TermFrequency.MONTHLY);
    expect(quote.termInstallments).toBe(4);
    expect(quote.installments).toHaveLength(4);
    expect(quote.monthlyInstallmentPesos).toBe(12500);
    expect(quote.totalPayablePesos).toBe(50000);
    expect(quote.principalPesos).toBe(50000);
    expect(quote.feePesos).toBe(0);
  });

  it("el monto de la cuota no depende de la fecha (solo las fechas)", async () => {
    const { db } = setup();

    const quote = await quoteLoanPlan(db, { productId: "MICRO_BASICO", amountPesos: 50000, termInstallments: 4 }, NOW);

    for (const cuota of quote.installments) {
      expect(cuota.totalPesos).toBe(12500);
      expect(new Date(cuota.dueDateIso).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("rechaza un plazo fuera del rango del producto", async () => {
    const { db } = setup();

    await expect(quoteLoanPlan(db, { productId: "MICRO_BASICO", amountPesos: 50000, termInstallments: 1 }, NOW)).rejects.toThrow(/2 a 6/);
    await expect(quoteLoanPlan(db, { productId: "MICRO_BASICO", amountPesos: 50000, termInstallments: 7 }, NOW)).rejects.toThrow(/2 a 6/);
  });

  it("rechaza un monto que no corresponde a ningún tier activo", async () => {
    const { db } = setup();

    await expect(quoteLoanPlan(db, { productId: "MICRO_BASICO", amountPesos: 60000, termInstallments: 4 }, NOW)).rejects.toThrow(/tier/);
  });

  it("rechaza un producto inexistente o inactivo", async () => {
    const { db } = setup();

    await expect(quoteLoanPlan(db, { productId: "NO_EXISTE", amountPesos: 50000, termInstallments: 4 }, NOW)).rejects.toThrow(/Producto/i);
  });
});

describe("tasas publicadas en la cotizacion (lo que el cliente ve antes de pedir)", () => {
  it("mensual: la tasa por periodo y la mensual son la misma cifra, no dos números", async () => {
    const { db } = setup({ annualRateBps: 2_400, effectiveFeeBps: 500 });
    const quote = await quoteLoanPlan(db, { productId: "MICRO_BASICO", amountPesos: 50000, termInstallments: 4 }, NOW);

    expect(quote.annualRateBps).toBe(2_400);
    expect(quote.periodRateBps).toBe(200);
    expect(quote.monthlyRateBps).toBe(200);
    expect(quote.effectiveFeeBps).toBe(500);
  });

  it("quincenal: separa el equivalente mensual de lo que se cobra cada quincena", async () => {
    const { db } = setup({
      annualRateBps: 2_400,
      effectiveFeeBps: 500,
      frequency: TermFrequency.BIWEEKLY,
    });
    const quote = await quoteLoanPlan(db, { productId: "MICRO_BASICO", amountPesos: 50000, termInstallments: 4 }, NOW);

    expect(quote.termFrequency).toBe(TermFrequency.BIWEEKLY);
    // 2400/26 = 92.3 -> 92: es lo que cobra el calendario.
    expect(quote.periodRateBps).toBe(92);
    // 2400/12 = 200: la referencia comparable entre productos.
    expect(quote.monthlyRateBps).toBe(200);
  });

  it("los pesos cobrados corresponden a la tasa por periodo publicada", async () => {
    const { db } = setup({ annualRateBps: 2_400, effectiveFeeBps: 500 });
    const quote = await quoteLoanPlan(db, { productId: "MICRO_BASICO", amountPesos: 50_000, termInstallments: 2 }, NOW);

    // La amortizacion francesa cobra la tasa por periodo sobre el saldo. Con un solo capital y
    // saldo inicial completo, el total de intereses tiene que ser el que produce esa misma tasa:
    // si la UI mostrara otra cifra, estos numeros no cruzarian.
    const saldoInicial = quote.principalPesos;
    const esperado = buildLoanSchedule({
      principalPesos: saldoInicial,
      annualRateBps: quote.periodRateBps * periodsPerYear(TermFrequency.MONTHLY),
      effectiveFeeBps: quote.effectiveFeeBps,
      termInstallments: quote.termInstallments,
      termFrequency: TermFrequency.MONTHLY,
      disbursementDate: NOW,
    });

    expect(quote.interestPesos).toBe(esperado.interestPesos);
    expect(quote.totalPayablePesos).toBe(esperado.totalPayablePesos);
    expect(quote.installments.map((c) => c.totalPesos)).toEqual(
      esperado.installments.map((c) => c.totalPesos),
    );
  });
});