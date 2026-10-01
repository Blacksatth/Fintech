import { describe, expect, it } from "vitest";
import { calculatePortfolioMetrics, type PortfolioLoan } from "./portfolio-math";
import { DelinquencyStatus, LoanStatus, RiskLevel } from "./types";

/**
 * Dataset de métricas (PROJECT_SPEC §13), un préstamo por cada situación del negocio:
 *
 * - `a-pagando`: DISBURSED, al día (CURRENT), pagó 1 de 5 cuotas.
 * - `b-vencido`: DISBURSED, OVERDUE, sin pagar.
 * - `c-mora: DISBURSED, DEFAULT, sin pagar.
 * - `d-pagado`: PAID, saldado por completo.
 * - `e-condonado`: WRITTEN_OFF, never se cobró (pérdida).
 * - `f-incumplido`: DEFAULTED, pagó una parte.
 * - `g-pendiente`: PENDING_DISBURSEMENT, aún sin desembolsar.
 *
 * `totalPayable = principal + interés + tarifa` (invariante de dinero del proyecto); los
 * `outstandingPesos` son la caché que escriben los servicios.
 */
function L(overrides: Partial<PortfolioLoan> = {}): PortfolioLoan {
  return {
    id: "loan",
    status: LoanStatus.DISBURSED,
    principalPesos: 100_000,
    interestPesos: 20_000,
    feePesos: 5_000,
    outstandingPesos: 100_000,
    delinquencyStatus: DelinquencyStatus.CURRENT,
    daysPastDue: 0,
    riskLevel: RiskLevel.LOW,
    ...overrides,
  };
}

function fullScenario(): PortfolioLoan[] {
  return [
    L({ id: "a-pagando", principalPesos: 100_000, interestPesos: 20_000, feePesos: 5_000, outstandingPesos: 100_000, disbursedAtMs: 1 }),
    L({ id: "b-vencido", principalPesos: 200_000, interestPesos: 40_000, feePesos: 10_000, outstandingPesos: 250_000, delinquencyStatus: DelinquencyStatus.OVERDUE, daysPastDue: 5, riskLevel: RiskLevel.MEDIUM, disbursedAtMs: 2 }),
    L({ id: "c-mora", principalPesos: 50_000, interestPesos: 0, feePesos: 0, outstandingPesos: 50_000, delinquencyStatus: DelinquencyStatus.DEFAULT, daysPastDue: 40, riskLevel: RiskLevel.HIGH, disbursedAtMs: 3 }),
    L({ id: "d-pagado", status: LoanStatus.PAID, principalPesos: 80_000, interestPesos: 16_000, feePesos: 4_000, outstandingPesos: 0, delinquencyStatus: DelinquencyStatus.PAID, disbursedAtMs: 4 }),
    L({ id: "e-condonado", status: LoanStatus.WRITTEN_OFF, principalPesos: 60_000, interestPesos: 12_000, feePesos: 3_000, outstandingPesos: 60_000, delinquencyStatus: DelinquencyStatus.DEFAULT, riskLevel: RiskLevel.HIGH, disbursedAtMs: 5 }),
    L({ id: "f-incumplido", status: LoanStatus.DEFAULTED, principalPesos: 40_000, interestPesos: 8_000, feePesos: 2_000, outstandingPesos: 30_000, delinquencyStatus: DelinquencyStatus.DEFAULT, daysPastDue: 60, riskLevel: RiskLevel.MEDIUM, disbursedAtMs: 6 }),
    L({ id: "g-pendiente", status: LoanStatus.PENDING_DISBURSEMENT, principalPesos: 30_000, interestPesos: 6_000, feePesos: 1_500, outstandingPesos: 37_500 }),
  ];
}

describe("calculatePortfolioMetrics (PROJECT_SPEC §13)", () => {
  it("calcula las 14 métricas sobre el dataset completo", () => {
    const m = calculatePortfolioMetrics(fullScenario());

    expect(m.carteraTotalPesos).toBe(430_000);
    expect(m.vigentePesos).toBe(100_000);
    expect(m.vencidaPesos).toBe(330_000);
    expect(m.enMoraPesos).toBe(80_000);
    expect(m.desembolsadoAcumuladoPesos).toBe(530_000);
    expect(m.recuperadoAcumuladoPesos).toBe(160_000);
    expect(m.saldoPendientePesos).toBe(490_000);
    expect(m.tasaMoraBps).toBe(7674);
    expect(m.tasaRecuperacionBps).toBe(3019);
    expect(m.prestamosActivos).toBe(4);
    expect(m.prestamosPagados).toBe(1);
    expect(m.prestamosIncumplidos).toBe(1);
    expect(m.perdidaCarteraPesos).toBe(60_000);
    expect(m.rendimientoBps).toBe(2264);
  });

  it("vigente + vencida = cartera total (partición del saldo cobrable)", () => {
    const m = calculatePortfolioMetrics(fullScenario());
    expect(m.vigentePesos + m.vencidaPesos).toBe(m.carteraTotalPesos);
  });

  it("recuperado + saldo pendiente = total pagable desembolsado", () => {
    const m = calculatePortfolioMetrics(fullScenario());
    const totalPagable = [125_000, 250_000, 50_000, 100_000, 75_000, 50_000].reduce((a, b) => a + b, 0);
    expect(m.recuperadoAcumuladoPesos + m.saldoPendientePesos).toBe(totalPagable);
  });

  it("particiones por estado, mora y riesgo para el dashboard", () => {
    const m = calculatePortfolioMetrics(fullScenario());

    expect(m.byDelinquencyStatus).toEqual({
      CURRENT: 2,
      DUE_SOON: 0,
      DUE_TODAY: 0,
      OVERDUE: 1,
      DEFAULT: 3,
      PAID: 1,
    });
    expect(m.byLoanStatus[LoanStatus.DISBURSED]).toBe(3);
    expect(m.byLoanStatus[LoanStatus.PAID]).toBe(1);
    expect(m.byLoanStatus[LoanStatus.DEFAULTED]).toBe(1);
    expect(m.byLoanStatus[LoanStatus.WRITTEN_OFF]).toBe(1);
    expect(m.byLoanStatus[LoanStatus.PENDING_DISBURSEMENT]).toBe(1);
    expect(m.byRiskLevel).toEqual({ LOW: 3, MEDIUM: 2, HIGH: 2 });
    expect(m.maxDaysPastDue).toBe(60);
  });

  it("cartera vacía: todo en cero, sin dividir entre cero", () => {
    const m = calculatePortfolioMetrics([]);

    expect(m.carteraTotalPesos).toBe(0);
    expect(m.vigentePesos).toBe(0);
    expect(m.vencidaPesos).toBe(0);
    expect(m.enMoraPesos).toBe(0);
    expect(m.desembolsadoAcumuladoPesos).toBe(0);
    expect(m.recuperadoAcumuladoPesos).toBe(0);
    expect(m.saldoPendientePesos).toBe(0);
    expect(m.tasaMoraBps).toBe(0);
    expect(m.tasaRecuperacionBps).toBe(0);
    expect(m.prestamosActivos).toBe(0);
    expect(m.prestamosPagados).toBe(0);
    expect(m.prestamosIncumplidos).toBe(0);
    expect(m.perdidaCarteraPesos).toBe(0);
    expect(m.rendimientoBps).toBe(0);
  });

  it("un préstamo desembolsado al día solo alimenta cartera/vigente", () => {
    const m = calculatePortfolioMetrics([
      L({ id: "fresco", principalPesos: 100_000, interestPesos: 20_000, feePesos: 5_000, outstandingPesos: 125_000 }),
    ]);

    expect(m.carteraTotalPesos).toBe(125_000);
    expect(m.vigentePesos).toBe(125_000);
    expect(m.vencidaPesos).toBe(0);
    expect(m.enMoraPesos).toBe(0);
    expect(m.desembolsadoAcumuladoPesos).toBe(100_000);
    expect(m.recuperadoAcumuladoPesos).toBe(0);
    expect(m.tasaMoraBps).toBe(0);
    expect(m.prestamosActivos).toBe(1);
    expect(m.rendimientoBps).toBe(2500);
  });

  it("un préstamo pagado por completo suma el total pagable al recuperado", () => {
    const m = calculatePortfolioMetrics([
      L({ status: LoanStatus.PAID, outstandingPesos: 0, delinquencyStatus: DelinquencyStatus.PAID }),
    ]);

    expect(m.recuperadoAcumuladoPesos).toBe(125_000);
    expect(m.saldoPendientePesos).toBe(0);
    expect(m.carteraTotalPesos).toBe(0);
    expect(m.prestamosPagados).toBe(1);
    expect(m.prestamosActivos).toBe(0);
  });

  it("el recuperado de un préstamo corrupto se pisa en 0 (no negativos)", () => {
    const m = calculatePortfolioMetrics([
      L({ principalPesos: 100_000, interestPesos: 0, feePesos: 0, outstandingPesos: 120_000 }),
    ]);

    expect(m.recuperadoAcumuladoPesos).toBe(0);
    expect(m.saldoPendientePesos).toBe(120_000);
  });

  it("un préstamo sin riesgo (sin score) no cuenta en la partición por riesgo", () => {
    const m = calculatePortfolioMetrics([L({ id: "sin-score", riskLevel: undefined }), L({ riskLevel: RiskLevel.HIGH })]);

    expect(m.byRiskLevel).toEqual({ LOW: 0, MEDIUM: 0, HIGH: 1 });
  });

  it("prestamosIncumplidos cuenta el estado DEFAULTED, la condonación es pérdida aparte", () => {
    const m = calculatePortfolioMetrics([
      L({ id: "incumplido", status: LoanStatus.DEFAULTED, outstandingPesos: 30_000, delinquencyStatus: DelinquencyStatus.DEFAULT, daysPastDue: 60 }),
      L({ id: "condonado", status: LoanStatus.WRITTEN_OFF, outstandingPesos: 60_000, delinquencyStatus: DelinquencyStatus.DEFAULT }),
    ]);

    expect(m.prestamosIncumplidos).toBe(1);
    expect(m.perdidaCarteraPesos).toBe(60_000);
    expect(m.carteraTotalPesos).toBe(30_000);
  });

  it("tasa de recuperación puede superar el 100% porque incluye el sobrante cobrado", () => {
    const m = calculatePortfolioMetrics([
      L({ status: LoanStatus.PAID, outstandingPesos: 0, delinquencyStatus: DelinquencyStatus.PAID }),
    ]);

    expect(m.tasaRecuperacionBps).toBe(12_500);
  });
});