import { add, assertSafeInteger, divMod, mul, roundDiv, sub } from "./money";
import { TermFrequency } from "./types";

const MS_PER_DAY = 86_400_000;
const BPS_DIVISOR = 10_000;
const MAX_ANNUAL_RATE_BPS = 100_000;
const MAX_FEE_BPS = 10_000;

export interface InstallmentSplit {
  installmentNumber: number;
  totalPesos: number;
}

export function splitAmountPesos(totalPesos: number, termInstallments: number): InstallmentSplit[] {
  const total = assertSafeInteger(totalPesos, "splitAmountPesos(total)");
  if (!Number.isSafeInteger(termInstallments) || termInstallments < 1) {
    throw new RangeError("splitAmountPesos: termInstallments debe ser un entero >= 1");
  }
  if (total < 0) {
    throw new RangeError("splitAmountPesos: totalPesos no puede ser negativo");
  }
  const { quotient, remainder } = divMod(total, termInstallments);
  const amounts = Array.from({ length: termInstallments }, (_, i) =>
    i === termInstallments - 1 ? quotient + remainder : quotient,
  );
  return amounts.map((totalPesos, i) => ({ installmentNumber: i + 1, totalPesos }));
}

const PERIODS_PER_YEAR: Record<TermFrequency, number> = {
  WEEKLY: 52,
  BIWEEKLY: 26,
  MONTHLY: 12,
};

const DAYS_PER_PERIOD: Partial<Record<TermFrequency, number>> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
};

/** Meses al ano: la convencion de "tasa mensual" del negocio (anual / 12). */
export const MONTHS_PER_YEAR = 12;

/** Periodos de amortizacion por anio, para prorratear una tasa anual bps al termino. */
export function periodsPerYear(frequency: TermFrequency): number {
  const value = PERIODS_PER_YEAR[frequency];
  if (value === undefined) {
    throw new RangeError(`schedule: frecuencia desconocida ${String(frequency)}`);
  }
  return value;
}

/**
 * Avanza `date` `periods` periodos de la frecuencia dada, en UTC.
 *
 * UTC y no local a propósito: los vencimientos no deben depender del reloj de la máquina
 * que corre el cálculo, ni del offset del servidor. Para mensual se recorta al último día
 * del mes destino (31-ene -> 28-feb), que es el caso donde `setUTCMonth` naive desborda
 * (31-ene + 1 mes -> 3-mar).
 */
export function addPeriods(date: Date, frequency: TermFrequency, periods: number): Date {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError("schedule: date invalida");
  }
  const count = assertSafeInteger(periods, "addPeriods(periods)");
  if (count < 1) {
    throw new RangeError("addPeriods: periods debe ser un entero >= 1");
  }
  const days = DAYS_PER_PERIOD[frequency];
  if (days === undefined) {
    if (frequency !== TermFrequency.MONTHLY) {
      throw new RangeError(`schedule: frecuencia desconocida ${String(frequency)}`);
    }
    return addMonths(date, count);
  }
  return new Date(date.getTime() + days * count * MS_PER_DAY);
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const dayOfMonth = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return result;
}

export interface ScheduledInstallment {
  installmentNumber: number;
  dueDate: Date;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  totalPesos: number;
}

export interface LoanScheduleInput {
  principalPesos: number;
  annualRateBps: number;
  effectiveFeeBps: number;
  termInstallments: number;
  termFrequency: TermFrequency;
  disbursementDate: Date;
}

export interface LoanSchedule {
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  totalPayablePesos: number;
  installments: ScheduledInstallment[];
}

function assertBps(value: number, max: number, context: string): number {
  const bps = assertSafeInteger(value, context);
  if (bps < 0 || bps > max) {
    throw new RangeError(`${context} debe estar entre 0 y ${max}`);
  }
  return bps;
}

/**
 * Amortización francesa (saldo decreciente) en pesos enteros (PROJECT_SPEC 6.4).
 *
 * Cada cuota es "nivel": cubre el interés del saldo pendiente y una porción de capital
 * que crece en cada cuota. La cuota nivel se resuelve con la fórmula de anidad
 * `A = P·i·(1+i)^n / ((1+i)^n − 1)`, que con potencias y raíces es racional: se evalúa con
 * `BigInt` para que el resultado sea EXACTO y el redondeo a pesos sea una sola decisión
 * explícita, en vez de arrastrar error de punto flotante a lo largo de 24 cuotas.
 *
 * Reparto:
 *  - Capital: `n−1` cuotas con `A − interés_k` y la última se queda con el saldo
 *    pendiente completo. Así la suma de capital es exactamente `P` por construcción, sin
 *    depender de que el redondeo cierre.
 *  - Interés: `roundDiv(saldo_k · bps_periodo, 10000)` sobre el saldo de cada cuota.
 *  - Tarifa: plana (`roundDiv(P · feeBps, 10000)`) repartida con `splitAmountPesos`.
 *  - El residuo (unos pesos por redondeo) queda en la última cuota, como manda la spec.
 *
 * La tasa por periodo se prorratea de la anual a bps enteros
 * (`roundDiv(annualRateBps, periodos_año)`), que redondea a la baja cuando no es exacta y
 * por tanto favorece al cliente. Con tasa 0 se delega en `splitAmountPesos` para no tener
 * dos convenciones distintas de residual.
 *
 * Los importes NO dependen de `disbursementDate`: esa fecha solo mueve los vencimientos.
 * Eso es lo que permite recalcular el calendario al confirmar el desembolso real sin que
 * cambien los pesos que el cliente ya aceptó.
 */
/**
 * Tasa que se cobra **por periodo** de pago, en bps enteros: la anual prorrateada a la frecuencia
 * del producto (`roundDiv(annualRateBps, periodos_año)`, redondeo a la baja).
 *
 * Vive aquí, y no duplicada en quien la muestra, por una razón concreta: la tasa mensual que ve el
 * cliente tiene que ser **la misma** que aplica `buildLoanSchedule`. Si la pantalla calculara una
 * tasa mensual equivalente por fórmula compuesta, publicaría un número más bonito y distinto del
 * que le van a cobrar. Un solo lugar para la regla evita que las dos cosas se separen.
 */
export function periodRateBpsFor(annualRateBps: number, frequency: TermFrequency): number {
  return roundDiv(assertBps(annualRateBps, MAX_ANNUAL_RATE_BPS, "periodRateBpsFor(annualRateBps)"), periodsPerYear(frequency));
}

export function buildLoanSchedule(input: LoanScheduleInput): LoanSchedule {
  const principalPesos = assertSafeInteger(input.principalPesos, "buildLoanSchedule(principalPesos)");
  if (principalPesos < 0) {
    throw new RangeError("buildLoanSchedule: principalPesos no puede ser negativo");
  }
  const termInstallments = assertSafeInteger(input.termInstallments, "buildLoanSchedule(termInstallments)");
  if (termInstallments < 1) {
    throw new RangeError("buildLoanSchedule: termInstallments debe ser un entero >= 1");
  }
  const annualRateBps = assertBps(input.annualRateBps, MAX_ANNUAL_RATE_BPS, "buildLoanSchedule(annualRateBps)");
  const effectiveFeeBps = assertBps(input.effectiveFeeBps, MAX_FEE_BPS, "buildLoanSchedule(effectiveFeeBps)");
  const periodRateBps = periodRateBpsFor(annualRateBps, input.termFrequency);
  const feePesos = roundDiv(mul(principalPesos, effectiveFeeBps), BPS_DIVISOR);
  const fees = splitAmountPesos(feePesos, termInstallments);

  const principals = periodRateBps === 0
    ? splitAmountPesos(principalPesos, termInstallments).map((c) => c.totalPesos)
    : amortizeFrench(principalPesos, periodRateBps, termInstallments);

  let balance = principalPesos;
  let interestTotal = 0;
  const installments: ScheduledInstallment[] = principals.map((principalCuota, i) => {
    const interestCuota = roundDiv(mul(balance, periodRateBps), BPS_DIVISOR);
    balance = sub(balance, principalCuota);
    interestTotal = add(interestTotal, interestCuota);
    const feeCuota = fees[i].totalPesos;
    return {
      installmentNumber: i + 1,
      dueDate: addPeriods(input.disbursementDate, input.termFrequency, i + 1),
      principalPesos: principalCuota,
      interestPesos: interestCuota,
      feePesos: feeCuota,
      totalPesos: add(add(principalCuota, interestCuota), feeCuota),
    };
  });

  return {
    principalPesos,
    interestPesos: interestTotal,
    feePesos,
    totalPayablePesos: add(add(principalPesos, interestTotal), feePesos),
    installments,
  };
}

/**
 * Reparte el capital de una amortización francesa en enteros.
 *
 * Devuelve `n` montos de capital cuya suma es exactamente `principalPesos`: las primeras
 * `n−1` cuotas pagan `nivel − interés` y la última cancela el saldo que queda. Si una cuota
 * no alcanzara a cubrir su interés (nivel ≤ interés) se falla en vez de amortizar al revés.
 */
function amortizeFrench(principalPesos: number, periodRateBps: number, periods: number): number[] {
  const levelPayment = annuityPayment(principalPesos, periodRateBps, periods);

  const principals: number[] = [];
  let balance = principalPesos;
  for (let i = 0; i < periods - 1; i++) {
    const interestCuota = roundDiv(mul(balance, periodRateBps), BPS_DIVISOR);
    const principalCuota = sub(levelPayment, interestCuota);
    if (principalCuota <= 0) {
      throw new RangeError(
        `amortizeFrench: la cuota nivel (${levelPayment}) no cubre el interes (${interestCuota})`,
      );
    }
    principals.push(principalCuota);
    balance = sub(balance, principalCuota);
  }
  principals.push(balance);
  return principals;
}

/**
 * Cuota nivel de una anidad, exacta y redondeada a pesos (.5 hacia arriba).
 *
 *   A = P · i · (1+i)^n / ((1+i)^n − 1)
 *
 * Con `R = 10000` e `i = bps/R`, multiplicando por `R^(n+1)` la expresión queda entera:
 *
 *   A = P · bps · (R+bps)^n / ( R · ((R+bps)^n − R^n) )
 *
 * Solo se redondea al final, una sola vez, que es justo lo que se quiere auditar.
 *
 * Se usan `BigInt(...)` y no literales `0n` porque el tsconfig del scaffold de Next va en
 * `target: ES2017`, que no habilita literales BigInt; subir el target por tres literales no
 * vale cambiar la transpilacion de todo el proyecto.
 */
/**
 * Invariante de dinero del plan: la suma de las cuotas debe reproducir exactamente los
 * totales. Vive acá (y no en el servicio) porque **dos** operaciones dependen de ella:
 * la creación del préstamo y el recálculo de vencimientos al confirmar el desembolso.
 * En el recálculo es la garantía de que re-programar fechas no puede mover un peso.
 */
export function assertScheduleIsBalanced(schedule: LoanSchedule): void {
  const sum = (campo: "principalPesos" | "interestPesos" | "feePesos" | "totalPesos") =>
    schedule.installments.reduce((acc, cuota) => add(acc, cuota[campo]), 0);
  if (sum("principalPesos") !== schedule.principalPesos) {
    throw new RangeError("assertScheduleIsBalanced: la suma de capital de las cuotas no coincide");
  }
  if (sum("interestPesos") !== schedule.interestPesos) {
    throw new RangeError("assertScheduleIsBalanced: la suma de intereses de las cuotas no coincide");
  }
  if (sum("feePesos") !== schedule.feePesos) {
    throw new RangeError("assertScheduleIsBalanced: la suma de comisiones de las cuotas no coincide");
  }
  if (sum("totalPesos") !== schedule.totalPayablePesos) {
    throw new RangeError("assertScheduleIsBalanced: la suma de las cuotas no coincide con el total");
  }
}

function annuityPayment(principalPesos: number, periodRateBps: number, periods: number): number {
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  const TWO = BigInt(2);

  const P = BigInt(principalPesos);
  const bps = BigInt(periodRateBps);
  const R = BigInt(BPS_DIVISOR);
  const n = BigInt(periods);

  const power = (R + bps) ** n;
  const denominator = R * (power - R ** n);
  if (denominator <= ZERO) {
    throw new RangeError("annuityPayment: tasa o plazo degenerados (denominador <= 0)");
  }
  const numerator = P * bps * power;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * TWO >= denominator ? quotient + ONE : quotient;
  return assertSafeInteger(Number(rounded), "annuityPayment");
}