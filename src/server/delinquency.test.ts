import { describe, expect, it } from "vitest";
import {
  DelinquencyError,
  daysPastDueForInstallment,
  parseDelinquencyThresholds,
  recalcLoanDelinquency,
  summarizeDelinquency,
  wholeDaysBetween,
} from "./delinquency";
import { DelinquencyStatus } from "./types";

const HOY = new Date("2026-03-24T00:00:00.000Z");
const UMBRALES = { dueSoonDays: 3, overdueDays: 1, defaultDays: 30 };

function cuota(overrides: Partial<Parameters<typeof recalcLoanDelinquency>[0][number]> = {}) {
  return {
    loanId: "loan-1",
    installmentNumber: 1,
    dueDate: HOY,
    principalPesos: 10_000,
    interestPesos: 2_000,
    feePesos: 1_414,
    totalPesos: 13_414,
    paidPesos: 0,
    status: "PENDING" as const,
    ...overrides,
  };
}

describe("wholeDaysBetween", () => {
  it("cuenta días de calendario en UTC, no horas", () => {
    expect(wholeDaysBetween(HOY, HOY)).toBe(0);
    expect(wholeDaysBetween(HOY, new Date("2026-03-25T00:00:00.000Z"))).toBe(1);
    expect(wholeDaysBetween(HOY, new Date("2026-03-23T00:00:00.000Z"))).toBe(-1);
    expect(wholeDaysBetween(HOY, new Date("2026-04-01T00:00:00.000Z"))).toBe(8);
  });

  it("acepta instantes que no son medianoche y los aterriza en su día", () => {
    const hoyMediodia = new Date("2026-03-24T15:30:00.000Z");
    expect(wholeDaysBetween(HOY, hoyMediodia)).toBe(0);
    expect(wholeDaysBetween(hoyMediodia, new Date("2026-03-25T01:00:00.000Z"))).toBe(1);
  });

  it("tolera timestamps de Firestore ({ toMillis })", () => {
    const ts = { toMillis: () => new Date("2026-03-26T00:00:00.000Z").getTime() };
    expect(wholeDaysBetween(ts, HOY)).toBe(-2);
  });
});

describe("daysPastDueForInstallment", () => {
  it("0 si vence hoy o en el futuro, positivo si venció", () => {
    expect(daysPastDueForInstallment(cuota(), HOY)).toBe(0);
    expect(
      daysPastDueForInstallment(cuota({ dueDate: new Date("2026-03-27T00:00:00.000Z") }), HOY),
    ).toBe(0);
    expect(
      daysPastDueForInstallment(cuota({ dueDate: new Date("2026-03-23T00:00:00.000Z") }), HOY),
    ).toBe(1);
  });
});

describe("parseDelinquencyThresholds", () => {
  it("acepta la config que siembra el seed", () => {
    expect(parseDelinquencyThresholds({ dueSoonDays: 3, overdueDays: 1, defaultDays: 30 })).toEqual({
      dueSoonDays: 3,
      overdueDays: 1,
      defaultDays: 30,
    });
  });

  it("rechaza umbrales sin sentido con un error de despliegue, no un estado absurdo", () => {
    expect(() => parseDelinquencyThresholds({ dueSoonDays: -1, overdueDays: 1, defaultDays: 30 })).toThrow(
      RangeError,
    );
    expect(() => parseDelinquencyThresholds({ dueSoonDays: 3, overdueDays: 0, defaultDays: 30 })).toThrow(
      /overdueDays/,
    );
    expect(() => parseDelinquencyThresholds({ dueSoonDays: 3, overdueDays: 5, defaultDays: 4 })).toThrow(
      /defaultDays/,
    );
    expect(() => parseDelinquencyThresholds("chequeado")).toThrow(RangeError);
    expect(() => parseDelinquencyThresholds({ dueSoonDays: 3, overdueDays: 1 })).toThrow(RangeError);
  });
});

describe("recalcLoanDelinquency", () => {
  it("todo pagado: PAID, saldo 0 y 0 días de atraso", () => {
    const cuotas = [cuota({ paidPesos: 13_414, status: "PAID" as const })];
    expect(recalcLoanDelinquency(cuotas, HOY, UMBRALES)).toEqual({
      outstandingPesos: 0,
      daysPastDue: 0,
      delinquencyStatus: DelinquencyStatus.PAID,
    });
  });

  it("el saldo es la suma de los saldos pendientes, no el total", () => {
    const cuotas = [
      cuota({ installmentNumber: 1, paidPesos: 13_414, status: "PAID" as const }),
      cuota({ installmentNumber: 2, totalPesos: 13_414, paidPesos: 4_000 }),
      cuota({ installmentNumber: 3, totalPesos: 13_414 }),
    ];
    const resultado = recalcLoanDelinquency(cuotas, HOY, UMBRALES);
    expect(resultado.outstandingPesos).toBe(22_828);
    expect(resultado.delinquencyStatus).toBe(DelinquencyStatus.DUE_TODAY);
  });

  it("vence dentro de la ventana de aviso: DUE_SOON", () => {
    const enTres = new Date("2026-03-27T00:00:00.000Z");
    const resultado = recalcLoanDelinquency([cuota({ dueDate: enTres })], HOY, UMBRALES);
    expect(resultado.daysPastDue).toBe(0);
    expect(resultado.delinquencyStatus).toBe(DelinquencyStatus.DUE_SOON);
  });

  it("lejos del vencimiento: CURRENT", () => {
    const enDiezDias = new Date("2026-04-03T00:00:00.000Z");
    expect(recalcLoanDelinquency([cuota({ dueDate: enDiezDias })], HOY, UMBRALES).delinquencyStatus).toBe(
      DelinquencyStatus.CURRENT,
    );
  });

  it("vence hoy: DUE_TODAY", () => {
    expect(recalcLoanDelinquency([cuota()], HOY, UMBRALES).delinquencyStatus).toBe(
      DelinquencyStatus.DUE_TODAY,
    );
  });

  it("un día de atraso (umbral overdueDays=1): OVERDUE", () => {
    const ayer = new Date("2026-03-23T00:00:00.000Z");
    const resultado = recalcLoanDelinquency([cuota({ dueDate: ayer })], HOY, UMBRALES);
    expect(resultado.daysPastDue).toBe(1);
    expect(resultado.delinquencyStatus).toBe(DelinquencyStatus.OVERDUE);
  });

  it("en el umbral de default: DEFAULT", () => {
    const haceTreinta = new Date("2026-02-22T00:00:00.000Z");
    expect(recalcLoanDelinquency([cuota({ dueDate: haceTreinta })], HOY, UMBRALES).delinquencyStatus).toBe(
      DelinquencyStatus.DEFAULT,
    );
  });

  it("daysPastDue es el máximo entre cuotas impagas, y mira la más antigua para el estado", () => {
    const reciente = new Date("2026-03-22T00:00:00.000Z");
    const antigua = hace(40);
    const resultado = recalcLoanDelinquency(
      [cuota({ installmentNumber: 1, dueDate: antigua }), cuota({ installmentNumber: 2, dueDate: reciente, paidPesos: 13_414, status: "PAID" as const })],
      HOY,
      UMBRALES,
    );
    expect(resultado.daysPastDue).toBe(40);
    expect(resultado.delinquencyStatus).toBe(DelinquencyStatus.DEFAULT);
  });

  it("sin cuotas no calcula nada", () => {
    expect(() => recalcLoanDelinquency([], HOY, UMBRALES)).toThrow(DelinquencyError);
  });

  it("una cuota con más pagado que su total es corrupción: falla en voz alta", () => {
    expect(() =>
      recalcLoanDelinquency([cuota({ paidPesos: 15_000 })], HOY, UMBRALES),
    ).toThrow(/datos corruptos/);
  });
});

function hace(dias: number): Date {
  return new Date(HOY.getTime() - dias * 86_400_000);
}

describe("summarizeDelinquency", () => {
  const entrada = (delinquencyStatus: DelinquencyStatus, outstandingPesos: number, daysPastDue = 0) => ({
    recalc: { outstandingPesos, daysPastDue, delinquencyStatus },
  });

  it("cartera vacía: todo en cero, no undefined", () => {
    expect(summarizeDelinquency([])).toEqual({
      loans: 0,
      outstandingPesos: 0,
      overduePesos: 0,
      inDefaultPesos: 0,
      dueSoonPesos: 0,
      maxDaysPastDue: 0,
      byStatus: { CURRENT: 0, DUE_SOON: 0, DUE_TODAY: 0, OVERDUE: 0, DEFAULT: 0, PAID: 0 },
    });
  });

  it("suma el saldo por estado y separa vencida de en mora", () => {
    const resumen = summarizeDelinquency([
      entrada(DelinquencyStatus.CURRENT, 50_000),
      entrada(DelinquencyStatus.DUE_SOON, 25_000),
      entrada(DelinquencyStatus.DUE_TODAY, 10_000),
      entrada(DelinquencyStatus.OVERDUE, 30_000, 5),
      entrada(DelinquencyStatus.DEFAULT, 40_000, 45),
    ]);

    expect(resumen.loans).toBe(5);
    expect(resumen.outstandingPesos).toBe(155_000);
    expect(resumen.overduePesos).toBe(70_000); // OVERDUE + DEFAULT
    expect(resumen.inDefaultPesos).toBe(40_000);
    expect(resumen.dueSoonPesos).toBe(35_000); // DUE_SOON + DUE_TODAY
    expect(resumen.maxDaysPastDue).toBe(45);
    expect(resumen.byStatus[DelinquencyStatus.OVERDUE]).toBe(1);
  });

  it("un préstamo saldado cuenta en el conteo pero no aporta saldo por cobrar", () => {
    const resumen = summarizeDelinquency([
      entrada(DelinquencyStatus.PAID, 0),
      entrada(DelinquencyStatus.CURRENT, 25_000),
    ]);

    expect(resumen.byStatus[DelinquencyStatus.PAID]).toBe(1);
    expect(resumen.loans).toBe(1);
    expect(resumen.outstandingPesos).toBe(25_000);
  });

  it("sumar en pesos enteros no pierde ni un peso, ni en el borde de MAX_SAFE_INTEGER", () => {
    const resumen = summarizeDelinquency([
      entrada(DelinquencyStatus.CURRENT, 9_007_199_254_740_986),
      entrada(DelinquencyStatus.CURRENT, 5),
    ]);

    expect(resumen.outstandingPesos).toBe(9_007_199_254_740_991);
  });

  it("una cartera que se sale del entero seguro revienta en vez de redondear", () => {
    expect(() =>
      summarizeDelinquency([
        entrada(DelinquencyStatus.CURRENT, 9_007_199_254_740_990),
        entrada(DelinquencyStatus.CURRENT, 5),
      ]),
    ).toThrow(RangeError);
  });

  it("un saldo que no sea entero seguro revienta en vez de redondear la cartera", () => {
    expect(() => summarizeDelinquency([entrada(DelinquencyStatus.CURRENT, 1_000.5)])).toThrow(RangeError);
  });
});
