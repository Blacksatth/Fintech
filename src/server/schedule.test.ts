import { describe, expect, it } from "vitest";
import { addPeriods, buildLoanSchedule, periodsPerYear, periodRateBpsFor, splitAmountPesos } from "./schedule";
import { add } from "./money";
import { TermFrequency } from "./types";

describe("schedule (division de cuotas enteras)", () => {
  it("divide exactamente en cuotas iguales", () => {
    const cuotas = splitAmountPesos(100000, 4).map((c) => c.totalPesos);
    expect(cuotas).toEqual([25000, 25000, 25000, 25000]);
  });

  it("el residuo se suma a la ultima cuota", () => {
    const cuotas = splitAmountPesos(100050, 4).map((c) => c.totalPesos);
    expect(cuotas).toEqual([25012, 25012, 25012, 25014]);
  });

  it("la suma de todas las cuotas nunca pierde pesos", () => {
    const total = 999983;
    const cuotas = splitAmountPesos(total, 7);
    const suma = cuotas.reduce((acc, c) => acc + c.totalPesos, 0);
    expect(cuotas).toHaveLength(7);
    expect(suma).toBe(total);
  });

  it("todas las cuotas son enteras no negativas", () => {
    const cuotas = splitAmountPesos(1234567, 13);
    for (const c of cuotas) {
      expect(Number.isSafeInteger(c.totalPesos)).toBe(true);
      expect(c.totalPesos).toBeGreaterThanOrEqual(0);
    }
  });

  it("numera las cuotas desde 1", () => {
    const cuotas = splitAmountPesos(30000, 3);
    expect(cuotas[0].installmentNumber).toBe(1);
    expect(cuotas[2].installmentNumber).toBe(3);
  });

  it("maneja total cero", () => {
    const cuotas = splitAmountPesos(0, 3).map((c) => c.totalPesos);
    expect(cuotas).toEqual([0, 0, 0]);
  });

  it("rechaza termino menor a 1 o no entero", () => {
    expect(() => splitAmountPesos(1000, 0)).toThrow(RangeError);
    expect(() => splitAmountPesos(1000, 1.5)).toThrow(RangeError);
  });

  it("rechaza total negativo", () => {
    expect(() => splitAmountPesos(-1, 4)).toThrow(RangeError);
  });

  it("rechaza total no entero", () => {
    expect(() => splitAmountPesos(1000.5, 4)).toThrow(RangeError);
  });
});

describe("schedule (vencimientos por frecuencia)", () => {
  const base = new Date("2026-01-15T00:00:00.000Z");

  it("monthly avanza un mes calendario", () => {
    const fechas = [1, 2, 3].map((n) => addPeriods(base, TermFrequency.MONTHLY, n).toISOString());
    expect(fechas).toEqual([
      "2026-02-15T00:00:00.000Z",
      "2026-03-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
    ]);
  });

  it("weekly avanza 7 dias", () => {
    expect(addPeriods(base, TermFrequency.WEEKLY, 2).toISOString()).toBe("2026-01-29T00:00:00.000Z");
  });

  it("biweekly avanza 14 dias por periodo", () => {
    expect(addPeriods(base, TermFrequency.BIWEEKLY, 1).toISOString()).toBe("2026-01-29T00:00:00.000Z");
    expect(addPeriods(base, TermFrequency.BIWEEKLY, 2).toISOString()).toBe("2026-02-12T00:00:00.000Z");
  });

  it("monthly recorta al ultimo dia del mes cuando no existe (31 de enero)", () => {
    const finDeMes = new Date("2026-01-31T00:00:00.000Z");
    expect(addPeriods(finDeMes, TermFrequency.MONTHLY, 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("monthly respeta el 29 de febrero en año bisiesto", () => {
    const bisiesto = new Date("2024-01-31T00:00:00.000Z");
    expect(addPeriods(bisiesto, TermFrequency.MONTHLY, 1).toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("no muta la fecha original", () => {
    const original = new Date("2026-01-15T00:00:00.000Z");
    addPeriods(original, TermFrequency.MONTHLY, 5);
    expect(original.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("rechaza periodos no enteros o negativos", () => {
    expect(() => addPeriods(base, TermFrequency.MONTHLY, 0)).toThrow(RangeError);
    expect(() => addPeriods(base, TermFrequency.MONTHLY, 1.5)).toThrow(RangeError);
    expect(() => addPeriods(base, TermFrequency.MONTHLY, -1)).toThrow(RangeError);
  });

  it("periodos por anio por frecuencia", () => {
    expect(periodsPerYear(TermFrequency.WEEKLY)).toBe(52);
    expect(periodsPerYear(TermFrequency.BIWEEKLY)).toBe(26);
    expect(periodsPerYear(TermFrequency.MONTHLY)).toBe(12);
  });
});

describe("schedule (plan de amortizacion uniforme)", () => {
  const disbursementDate = new Date("2026-01-15T00:00:00.000Z");

  function plan(overrides: Partial<Parameters<typeof buildLoanSchedule>[0]> = {}) {
    return buildLoanSchedule({
      principalPesos: 50_000,
      annualRateBps: 2_400,
      effectiveFeeBps: 500,
      termInstallments: 2,
      termFrequency: TermFrequency.MONTHLY,
      disbursementDate,
      ...overrides,
    });
  }

  it("la tarifa se prorratea en linea desde bps y el total cuadra", () => {
    const resultado = plan();
    // 50000 * 500bps / 10000 = 2500
    expect(resultado.feePesos).toBe(2_500);
    expect(resultado.totalPayablePesos).toBe(
      resultado.principalPesos + resultado.interestPesos + resultado.feePesos,
    );
  });

  it("el total a pagar es exactamente principal + interes + tarifa", () => {
    const resultado = plan();
    expect(resultado.totalPayablePesos).toBe(
      add(add(resultado.principalPesos, resultado.interestPesos), resultado.feePesos),
    );
  });

  it("genera exactamente termInstallments cuotas numeradas desde 1", () => {
    const resultado = plan({ termInstallments: 4 });
    expect(resultado.installments).toHaveLength(4);
    expect(resultado.installments.map((c) => c.installmentNumber)).toEqual([1, 2, 3, 4]);
  });

  it("la suma de cada componente de las cuotas es exacta", () => {
    const resultado = plan({ termInstallments: 7 });
    const suma = (campo: "principalPesos" | "interestPesos" | "feePesos" | "totalPesos") =>
      resultado.installments.reduce((acc, c) => acc + c[campo], 0);
    expect(suma("principalPesos")).toBe(resultado.principalPesos);
    expect(suma("interestPesos")).toBe(resultado.interestPesos);
    expect(suma("feePesos")).toBe(resultado.feePesos);
    expect(suma("totalPesos")).toBe(resultado.totalPayablePesos);
  });

  it("con tasa 0 el capital se reparte como splitAmountPesos (residuo en la ultima)", () => {
    const resultado = plan({ principalPesos: 100_050, termInstallments: 4, annualRateBps: 0, effectiveFeeBps: 0 });
    expect(resultado.installments.map((c) => c.principalPesos)).toEqual([25_012, 25_012, 25_012, 25_014]);
  });

  it("las cuotas son iguales salvo el residuo de la ultima", () => {
    const resultado = plan({ principalPesos: 100_000, termInstallments: 4, annualRateBps: 0, effectiveFeeBps: 0 });
    const totales = resultado.installments.map((c) => c.totalPesos);
    expect(totales).toEqual([25_000, 25_000, 25_000, 25_000]);
  });

  it("todos los importes son enteros seguros", () => {
    const resultado = plan({ termInstallments: 13, principalPesos: 1_234_567 });
    for (const cuota of resultado.installments) {
      for (const valor of [cuota.principalPesos, cuota.interestPesos, cuota.feePesos, cuota.totalPesos]) {
        expect(Number.isSafeInteger(valor)).toBe(true);
      }
    }
  });

  it("tasa 0 (arranque PENDING_LEGAL_REVIEW) deja el total en el capital", () => {
    const resultado = plan({ annualRateBps: 0, effectiveFeeBps: 0, termInstallments: 3 });
    expect(resultado.interestPesos).toBe(0);
    expect(resultado.feePesos).toBe(0);
    expect(resultado.totalPayablePesos).toBe(50_000);
    expect(resultado.installments.map((c) => c.totalPesos)).toEqual([16_666, 16_666, 16_668]);
  });

  it("las fechas de vencimiento siguen la frecuencia y son crecientes", () => {
    const resultado = plan({ termFrequency: TermFrequency.BIWEEKLY, termInstallments: 3 });
    const fechas = resultado.installments.map((c) => c.dueDate.toISOString());
    expect(fechas).toEqual([
      "2026-01-29T00:00:00.000Z",
      "2026-02-12T00:00:00.000Z",
      "2026-02-26T00:00:00.000Z",
    ]);
  });

  it("el primer vencimiento es un periodo despues del desembolso, no el desembolso", () => {
    const resultado = plan();
    expect(resultado.installments[0].dueDate.getTime()).toBeGreaterThan(disbursementDate.getTime());
  });

  it("rechaza capital no entero o negativo", () => {
    expect(() => plan({ principalPesos: 1000.5 })).toThrow(RangeError);
    expect(() => plan({ principalPesos: -1 })).toThrow(RangeError);
  });

  it("rechaza bps fuera de rango o no entero", () => {
    expect(() => plan({ annualRateBps: -1 })).toThrow(RangeError);
    expect(() => plan({ effectiveFeeBps: 1.5 })).toThrow(RangeError);
  });

  it("rechaza termino menor a 1", () => {
    expect(() => plan({ termInstallments: 0 })).toThrow(RangeError);
  });

  it("rechaza frecuencia desconocida", () => {
    expect(() => plan({ termFrequency: "DAILY" as never })).toThrow(RangeError);
  });
});

describe("periodRateBpsFor (tasa por periodo, la que se muestra al cliente)", () => {
  it("prorratea la anual a la frecuencia sin perder la convencion de bps enteros", () => {
    expect(periodRateBpsFor(2_400, TermFrequency.MONTHLY)).toBe(200);
    expect(periodRateBpsFor(2_400, TermFrequency.BIWEEKLY)).toBe(92);
    // 2400/52 = 46.15 -> 46
    expect(periodRateBpsFor(2_400, TermFrequency.WEEKLY)).toBe(46);
  });

  it("es exactamente la tasa que cobra el plan, no una aproximacion pedagogica", () => {
    // La misma cifra que usa el motor evita que el cliente vea un 2,00 % y el contrato cobre otra.
    const plan = buildLoanSchedule({
      principalPesos: 50_000,
      annualRateBps: 2_400,
      effectiveFeeBps: 500,
      termInstallments: 1,
      termFrequency: TermFrequency.BIWEEKLY,
      disbursementDate: new Date("2026-03-10T00:00:00.000Z"),
    });
    // 50000 * 92bps / 10000 = 460
    expect(plan.installments[0].interestPesos).toBe(460);
    expect(periodRateBpsFor(2_400, TermFrequency.BIWEEKLY)).toBe(92);
  });

  it("tasa 0 y frecuencias invalidas", () => {
    expect(periodRateBpsFor(0, TermFrequency.MONTHLY)).toBe(0);
    expect(() => periodRateBpsFor(-1, TermFrequency.MONTHLY)).toThrow(RangeError);
    expect(() => periodRateBpsFor(100, "DAILY" as never)).toThrow(RangeError);
  });
});

describe("schedule (amortizacion francesa sobre saldo decreciente)", () => {
  const disbursementDate = new Date("2026-03-10T00:00:00.000Z");

  function plan(overrides: Partial<Parameters<typeof buildLoanSchedule>[0]> = {}) {
    return buildLoanSchedule({
      principalPesos: 50_000,
      annualRateBps: 2_400,
      effectiveFeeBps: 500,
      termInstallments: 2,
      termFrequency: TermFrequency.MONTHLY,
      disbursementDate,
      ...overrides,
    });
  }

  it("la cuota nivel se calcula con la formula de anidad, no prorrateo plano", () => {
    // i = 200bps/periodo (2400/12). A = P*i*(1+i)^n / ((1+i)^n - 1) = 25752.47 -> 25752
    const resultado = plan();
    expect(resultado.installments[0].totalPesos).toBe(25_752 + 1_250);
    // saldo 50000 -> interes 1000, capital 24752, saldo 25248
    expect(resultado.installments[0].interestPesos).toBe(1_000);
    expect(resultado.installments[0].principalPesos).toBe(24_752);
  });

  it("el interes total es menor que el prorrateo plano (se paga sobre saldo menor)", () => {
    // prorrateo plano habria dado 2000; la francesa da 1505
    const resultado = plan();
    expect(resultado.interestPesos).toBe(1_505);
    expect(resultado.feePesos).toBe(2_500);
    expect(resultado.totalPayablePesos).toBe(54_005);
  });

  it("la ultima cuota absorbe el saldo restante y el residuo de redondeo", () => {
    const resultado = plan();
    const ultima = resultado.installments[1];
    // la ultima capital = saldo pendiente completo (25248), no una parte proporcional
    expect(ultima.principalPesos).toBe(25_248);
    expect(ultima.interestPesos).toBe(505);
    expect(ultima.totalPesos).toBe(25_248 + 505 + 1_250);
  });

  it("el capital de cada cuota es creciente (firma de la amortizacion francesa)", () => {
    const resultado = plan({ termInstallments: 6 });
    const capitales = resultado.installments.map((c) => c.principalPesos);
    for (let i = 1; i < capitales.length; i++) {
      expect(capitales[i]).toBeGreaterThan(capitales[i - 1]);
    }
  });

  it("el interes de cada cuota es decreciente", () => {
    const resultado = plan({ termInstallments: 6 });
    const intereses = resultado.installments.map((c) => c.interestPesos);
    for (let i = 1; i < intereses.length; i++) {
      expect(intereses[i]).toBeLessThan(intereses[i - 1]);
    }
  });

  it("todas las cuotas salvo la ultima son exactamente iguales", () => {
    for (const term of [3, 4, 12, 24]) {
      const resultado = plan({ termInstallments: term, principalPesos: 5_000_000, annualRateBps: 3_600, effectiveFeeBps: 250 });
      const totales = resultado.installments.map((c) => c.totalPesos);
      const nivel = totales.slice(0, -1);
      // todas menos la ultima coinciden al peso
      for (const total of nivel) {
        expect(total).toBe(nivel[0]);
      }
      // la ultima se lleva el residuo acumulado, que es pequeno frente a la cuota
      expect(Math.abs(totales[totales.length - 1] - nivel[0])).toBeLessThan(nivel[0] * 0.01);
    }
  });

  it("no pierde precision con un plazo largo y capital grande", () => {
    const resultado = plan({ principalPesos: 5_000_000, annualRateBps: 3_600, termInstallments: 24, effectiveFeeBps: 250 });
    const sumaTotal = resultado.installments.reduce((acc, c) => acc + c.totalPesos, 0);
    const sumaCapital = resultado.installments.reduce((acc, c) => acc + c.principalPesos, 0);
    expect(sumaCapital).toBe(5_000_000);
    expect(sumaTotal).toBe(resultado.totalPayablePesos);
    for (const cuota of resultado.installments) {
      expect(Number.isSafeInteger(cuota.totalPesos)).toBe(true);
    }
  });

  it("el capital de todas las cuotas suma exactamente el capital del prestamo", () => {
    for (const term of [1, 2, 3, 7, 12, 24]) {
      const resultado = plan({ termInstallments: term });
      const suma = resultado.installments.reduce((acc, c) => acc + c.principalPesos, 0);
      expect(suma).toBe(resultado.principalPesos);
    }
  });

  it("la tasa por periodo se prorratea desde la anual y se redondea a bps enteros", () => {
    // 2400bps anuales: mensual -> 200bps, semanal -> 46bps (46.15 redondeado)
    const mensual = plan({ termInstallments: 1 });
    expect(mensual.installments[0].interestPesos).toBe(1_000);

    const semanal = plan({ termInstallments: 1, termFrequency: TermFrequency.WEEKLY, annualRateBps: 2_400 });
    // 50000 * 46bps / 10000 = 230
    expect(semanal.installments[0].interestPesos).toBe(230);
  });

  it("recalcula con otra fecha base sin cambiar un solo peso de los importes", () => {
    // El calendario es tentativo hasta el desembolso real (F9): al recalcular con la fecha
    // real, los importes deben ser identicos y solo se mueven los vencimientos.
    const original = plan({ disbursementDate: new Date("2026-03-10T00:00:00.000Z") });
    const recalculado = plan({ disbursementDate: new Date("2026-04-02T00:00:00.000Z") });

    const importes = (r: typeof original) => r.installments.map((c) => [c.principalPesos, c.interestPesos, c.feePesos, c.totalPesos]);
    expect(importes(recalculado)).toEqual(importes(original));
    expect(recalculado.totalPayablePesos).toBe(original.totalPayablePesos);
    expect(recalculado.installments.map((c) => c.dueDate.toISOString())).toEqual([
      "2026-05-02T00:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
    ]);
  });

  it("no pierde precision con un plazo largo y capital grande", () => {
    const resultado = plan({ principalPesos: 5_000_000, annualRateBps: 3_600, termInstallments: 24, effectiveFeeBps: 250 });
    const sumaTotal = resultado.installments.reduce((acc, c) => acc + c.totalPesos, 0);
    const sumaCapital = resultado.installments.reduce((acc, c) => acc + c.principalPesos, 0);
    expect(sumaCapital).toBe(5_000_000);
    expect(sumaTotal).toBe(resultado.totalPayablePesos);
    for (const cuota of resultado.installments) {
      expect(Number.isSafeInteger(cuota.totalPesos)).toBe(true);
      expect(cuota.totalPesos).toBeGreaterThan(0);
    }
  });
});