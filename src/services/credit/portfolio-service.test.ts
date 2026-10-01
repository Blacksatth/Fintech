import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createFirestoreMock, type InMemoryFirestore } from "@/test-utils/firestore-mock";
import {
  getPortfolioMetrics,
  PORTFOLIO_SCAN_LIMIT,
  type PortfolioFilters,
} from "./portfolio-service";
import { DelinquencyStatus, LoanStatus, RiskLevel, TermFrequency } from "@/server/types";

/** Dataset de cartera: +activo, +vencido, +incumplido, +pagado, +pendiente, legacy sin esquema. */
const DIAS = (days: number): Date => new Date(Date.UTC(2026, 0, 1 + days));

interface LoanSeed {
  id: string;
  status: LoanStatus;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  outstandingPesos: number;
  delinquencyStatus: DelinquencyStatus;
  daysPastDue: number;
  applicationId: string;
  disbursedAt?: Date;
  riskLevel?: RiskLevel;
}

const LOANS: LoanSeed[] = [
  { id: "loan-fresca", status: LoanStatus.DISBURSED, principalPesos: 100_000, interestPesos: 20_000, feePesos: 5_000, outstandingPesos: 100_000, delinquencyStatus: DelinquencyStatus.CURRENT, daysPastDue: 0, applicationId: "APP-1", disbursedAt: DIAS(40), riskLevel: RiskLevel.LOW },
  { id: "loan-vencida", status: LoanStatus.DISBURSED, principalPesos: 200_000, interestPesos: 40_000, feePesos: 10_000, outstandingPesos: 250_000, delinquencyStatus: DelinquencyStatus.OVERDUE, daysPastDue: 5, applicationId: "APP-2", disbursedAt: DIAS(14), riskLevel: RiskLevel.MEDIUM },
  { id: "loan-incumplida", status: LoanStatus.DEFAULTED, principalPesos: 40_000, interestPesos: 8_000, feePesos: 2_000, outstandingPesos: 30_000, delinquencyStatus: DelinquencyStatus.DEFAULT, daysPastDue: 60, applicationId: "APP-3", disbursedAt: DIAS(60), riskLevel: RiskLevel.HIGH },
  { id: "loan-pagada", status: LoanStatus.PAID, principalPesos: 80_000, interestPesos: 16_000, feePesos: 4_000, outstandingPesos: 0, delinquencyStatus: DelinquencyStatus.PAID, daysPastDue: 0, applicationId: "APP-4", disbursedAt: DIAS(0), riskLevel: RiskLevel.LOW },
  { id: "loan-pendiente", status: LoanStatus.PENDING_DISBURSEMENT, principalPesos: 30_000, interestPesos: 6_000, feePesos: 1_500, outstandingPesos: 37_500, delinquencyStatus: DelinquencyStatus.CURRENT, daysPastDue: 0, applicationId: "APP-5", riskLevel: RiskLevel.LOW },
];

function loanDoc(item: LoanSeed) {
  return {
    loanNumber: `LOAN-${item.id.toUpperCase()}`,
    applicationId: item.applicationId,
    userId: `uid-${item.id}`,
    productCode: "MICRO_BASICO",
    principalPesos: item.principalPesos,
    interestPesos: item.interestPesos,
    feePesos: item.feePesos,
    totalPayablePesos: item.principalPesos + item.interestPesos + item.feePesos,
    pricing: {
      annualRateBps: 2400,
      effectiveFeeBps: 500,
      rateVersion: 1,
      termInstallments: 4,
      termFrequency: TermFrequency.MONTHLY,
    },
    status: item.status,
    delinquencyStatus: item.delinquencyStatus,
    daysPastDue: item.daysPastDue,
    outstandingPesos: item.outstandingPesos,
    disbursedAt: item.disbursedAt,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function setup(seed: LoanSeed[] = LOANS): { db: Firestore; store: InMemoryFirestore } {
  const { store, db } = createFirestoreMock();

  for (const item of seed) {
    store.seed("loans", item.id, loanDoc(item));
    if (item.riskLevel !== undefined && item.applicationId) {
      store.seed("credit_scores", item.applicationId, {
        userId: `uid-${item.id}`,
        applicationId: item.applicationId,
        score: item.riskLevel === RiskLevel.LOW ? 80 : item.riskLevel === RiskLevel.MEDIUM ? 55 : 30,
        riskLevel: item.riskLevel,
        factors: [],
        modelVersion: "rule-v1",
        calculatedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
    }
  }

  // Un préstamo legado previo al esquema actual: sin campos de dinero, no puede alimentar métricas.
  store.seed("loans", "loan-legacy", {
    userId: "uid-legacy",
    status: LoanStatus.DISBURSED,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  return { db: db as Firestore, store };
}

async function metricsFor(filters: PortfolioFilters = {}) {
  const { db } = setup();
  return getPortfolioMetrics({ db }, { filters });
}

describe("getPortfolioMetrics", () => {
  it("agrega las métricas sobre la caché de `loans` y el join del score", async () => {
    const { metrics, skippedLegacy, truncated } = await metricsFor();

    expect(metrics.carteraTotalPesos).toBe(380_000);
    expect(metrics.vigentePesos).toBe(100_000);
    expect(metrics.vencidaPesos).toBe(280_000);
    expect(metrics.enMoraPesos).toBe(30_000);
    expect(metrics.desembolsadoAcumuladoPesos).toBe(420_000);
    expect(metrics.recuperadoAcumuladoPesos).toBe(145_000);
    expect(metrics.saldoPendientePesos).toBe(380_000);
    expect(metrics.tasaMoraBps).toBe(7368);
    expect(metrics.tasaRecuperacionBps).toBe(3452);
    expect(metrics.prestamosActivos).toBe(3);
    expect(metrics.prestamosPagados).toBe(1);
    expect(metrics.prestamosIncumplidos).toBe(1);
    expect(metrics.perdidaCarteraPesos).toBe(0);
    expect(metrics.rendimientoBps).toBe(2500);

    expect(metrics.byLoanStatus[LoanStatus.DISBURSED]).toBe(2);
    expect(metrics.byRiskLevel).toEqual({ LOW: 3, MEDIUM: 1, HIGH: 1 });
    expect(metrics.maxDaysPastDue).toBe(60);

    expect(skippedLegacy).toBe(1);
    expect(truncated).toBe(false);
  });

  it("filtra por estado del préstamo", async () => {
    const { metrics } = await metricsFor({ status: LoanStatus.DEFAULTED });

    expect(metrics.prestamosActivos).toBe(1);
    expect(metrics.carteraTotalPesos).toBe(30_000);
    expect(metrics.enMoraPesos).toBe(30_000);
    expect(metrics.desembolsadoAcumuladoPesos).toBe(40_000);
    expect(metrics.recuperadoAcumuladoPesos).toBe(20_000);
  });

  it("filtra por rango de monto (principal)", async () => {
    const { metrics } = await metricsFor({ maxPrincipalPesos: 100_000 });

    expect(metrics.desembolsadoAcumuladoPesos).toBe(220_000);
    expect(metrics.carteraTotalPesos).toBe(130_000);
    expect(metrics.prestamosActivos).toBe(2);
  });

  it("filtra por monto mínimo", async () => {
    const { metrics } = await metricsFor({ minPrincipalPesos: 100_000 });

    expect(metrics.desembolsadoAcumuladoPesos).toBe(300_000);
    expect(metrics.carteraTotalPesos).toBe(350_000);
    expect(metrics.prestamosActivos).toBe(2);
  });

  it("filtra por riesgo (join con credit_scores)", async () => {
    const { metrics } = await metricsFor({ riskLevel: RiskLevel.HIGH });

    expect(metrics.carteraTotalPesos).toBe(30_000);
    expect(metrics.prestamosActivos).toBe(1);
    expect(metrics.byRiskLevel).toEqual({ LOW: 0, MEDIUM: 0, HIGH: 1 });
  });

  it("filtra por mora (estado de mora recalculado)", async () => {
    const { metrics } = await metricsFor({ delinquencyStatus: DelinquencyStatus.OVERDUE });

    expect(metrics.carteraTotalPesos).toBe(250_000);
    expect(metrics.vencidaPesos).toBe(250_000);
    expect(metrics.vigentePesos).toBe(0);
    expect(metrics.maxDaysPastDue).toBe(5);
  });

  it("filtra por días de atraso mínimo", async () => {
    const { metrics } = await metricsFor({ minDaysPastDue: 30 });

    expect(metrics.carteraTotalPesos).toBe(30_000);
    expect(metrics.prestamosActivos).toBe(1);
  });

  it("filtra por fecha de desembolso (desde)", async () => {
    const { metrics } = await metricsFor({ disbursedFromMs: DIAS(30).getTime() });

    expect(metrics.desembolsadoAcumuladoPesos).toBe(140_000);
    expect(metrics.carteraTotalPesos).toBe(130_000);
    expect(metrics.prestamosActivos).toBe(2);
  });

  it("filtra por fecha de desembolso (hasta)", async () => {
    const { metrics } = await metricsFor({ disbursedToMs: DIAS(20).getTime() });

    expect(metrics.desembolsadoAcumuladoPesos).toBe(280_000);
    expect(metrics.carteraTotalPesos).toBe(250_000);
  });

  it("sin cartera que coincida con los filtros: todo en cero", async () => {
    const { metrics, skippedLegacy } = await metricsFor({ status: LoanStatus.WRITTEN_OFF });
    expect(metrics.carteraTotalPesos).toBe(0);
    expect(metrics.prestamosPagados).toBe(0);
    expect(metrics.tasaMoraBps).toBe(0);
    expect(skippedLegacy).toBe(1);
  });

  it("LOS legados sin esquema cuentan como `skippedLegacy` y no alimentan métricas", async () => {
    const { db } = setup([]);
    const result = await getPortfolioMetrics({ db }, {});

    expect(result.skippedLegacy).toBe(1);
    expect(result.metrics.prestamosActivos).toBe(0);
    expect(result.loans).toHaveLength(0);
  });
});

describe("PORTFOLIO_SCAN_LIMIT", () => {
  it("superado, marca truncated para no vender métricas de una cartera incompleta", async () => {
    const { db } = setup(LOANS.slice(0, 3));
    for (let i = 0; i < PORTFOLIO_SCAN_LIMIT; i += 1) {
      db.collection("loans").doc(`bulk-${i}`).set(loanDoc({ ...LOANS[0], id: `bulk-${i}` }));
    }
    const result = await getPortfolioMetrics({ db }, {});

    expect(result.truncated).toBe(true);
  });
});