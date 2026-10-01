import type { LoanInstallmentDoc } from "@/server/credit-doc";
import type { CreditDocDate } from "@/server/credit-doc";
import { DelinquencyStatus } from "@/server/types";
import { add, sub } from "@/server/money";

/**
 * Motor de mora (PROJECT_SPEC §13). Dominio puro: sin Firebase ni Next, para que las fechas y
 * los umbrales se prueben sin infraestructura.
 *
 * PROJECT_SPEC §13:
 * - `daysPastDue` por cuota = `máx(0, hoy - dueDate)`; a nivel préstamo = máximo entre las
 *   cuotas impagas.
 * - Estados `CURRENT | DUE_SOON | DUE_TODAY | OVERDUE | DEFAULT | PAID` derivados de cuotas +
 *   fechas, con umbrales configurables (`system_config/delinquency`): `dueSoonDays`,
 *   `overdueDays`, `defaultDays`.
 *
 * Nació aquí en F10-2b porque la confirmación de un pago recalcula saldo y mora del préstamo;
 * F11-1 lo reutiliza para el recálculo bajo demanda y la UI de cartera.
 */

export class DelinquencyError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "DelinquencyError";
    this.statusCode = statusCode;
  }
}

export interface DelinquencyThresholds {
  /** Cuántos días **antes** del vencimiento empieza a avisarse (`DUE_SOON`). */
  dueSoonDays: number;
  /** A partir de cuántos días de atraso el préstamo es `OVERDUE`. */
  overdueDays: number;
  /** A partir de cuántos días de atraso el préstamo es `DEFAULT`. */
  defaultDays: number;
}

/**
 * Valida los umbrales que vienen de `system_config/delinquency`. Los umbrales son operativos:
 * con una `dueSoonDays` negativa o un `defaultDays` menor al `overdueDays`, la clasificación
 * dejaría de tener sentido y es mejor fallar que escribir una mora absurda en `loans`.
 */
export function parseDelinquencyThresholds(value: unknown): DelinquencyThresholds {
  const config = value as Record<string, unknown>;
  const dueSoonDays = config?.["dueSoonDays"];
  const overdueDays = config?.["overdueDays"];
  const defaultDays = config?.["defaultDays"];
  if (
    !Number.isInteger(dueSoonDays) ||
    !Number.isInteger(overdueDays) ||
    !Number.isInteger(defaultDays)
  ) {
    throw new RangeError(
      `Configuración de mora inválida: se esperaban enteros dueSoonDays/overdueDays/defaultDays ` +
        `(recibido ${String(dueSoonDays)}/${String(overdueDays)}/${String(defaultDays)})`,
    );
  }
  if ((dueSoonDays as number) < 0) {
    throw new RangeError("dueSoonDays no puede ser negativo");
  }
  if ((overdueDays as number) < 1) {
    throw new RangeError("overdueDays debe ser >= 1 (un préstamo se vence al primer día de atraso)");
  }
  if ((defaultDays as number) < (overdueDays as number)) {
    throw new RangeError("defaultDays debe ser >= overdueDays");
  }
  return {
    dueSoonDays: dueSoonDays as number,
    overdueDays: overdueDays as number,
    defaultDays: defaultDays as number,
  };
}

function toMillis(value: CreditDocDate): number {
  if (value instanceof Date) return value.getTime();
  return value.toMillis();
}

/** Día (UTC) en el que cae una instante, como marca del 00:00 local-UTC. */
function utcDayStart(value: CreditDocDate): number {
  const date = new Date(toMillis(value));
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Días **enteros** (de calendario, en UTC) entre dos fechas. Puede salir negativo si `from`
 * es posterior a `to`.
 *
 * Los vencimientos son días concretos a medianoche UTC (trampa conocida del proyecto: formatear
 * en zona del navegador los recorre un día). Normalizando ambos extremos al inicio del día UTC
 * la diferencia siempre es múltiplo exacto de 24 h, así que el redondeo nunca inventa un día.
 */
export function wholeDaysBetween(from: CreditDocDate, to: CreditDocDate): number {
  return Math.round((utcDayStart(to) - utcDayStart(from)) / 86_400_000);
}

/** `máx(0, hoy - dueDate)`: cuántos días lleva vencida una cuota (0 si aún no o vence hoy). */
export function daysPastDueForInstallment(installment: Pick<LoanInstallmentDoc, "dueDate">, today: Date): number {
  return Math.max(0, wholeDaysBetween(installment.dueDate, today));
}

export interface LoanDelinquencyResult {
  /** Suma de los saldos de las cuotas no pagadas: lo que queda por cobrar del préstamo. */
  outstandingPesos: number;
  /** Máximo entre cuotas impagas de `máx(0, hoy - dueDate)`. */
  daysPastDue: number;
  delinquencyStatus: DelinquencyStatus;
}

interface UnpaidInstallment {
  installmentNumber: number;
  dueDate: CreditDocDate;
  balancePesos: number;
}

/**
 * Saldo y mora de un préstamo a partir de **sus cuotas** y del día de hoy.
 *
 * La cuota pendiente es la única fuente de verdad (decisión de F8-3): no se confía en el
 * `status` de la cuota ni en lo que `loans` traiga cacheado. Un préstamo con una cuota que
 * tiene más pagado que su total es un dato corrupto: el recálculo se niega en voz alta en vez
 * de escribir un saldo negativo que los filtros admin propagarían después.
 */
export function recalcLoanDelinquency(
  installments: readonly LoanInstallmentDoc[],
  today: Date,
  thresholds: DelinquencyThresholds,
): LoanDelinquencyResult {
  const config = parseDelinquencyThresholds(thresholds);

  if (installments.length === 0) {
    throw new DelinquencyError("El préstamo no tiene cuotas: no se puede calcular su saldo");
  }

  const unpaid: UnpaidInstallment[] = [];
  let outstandingPesos = 0;
  for (const cuota of installments) {
    const balance = sub(cuota.totalPesos, cuota.paidPesos);
    if (balance < 0) {
      throw new DelinquencyError(
        `La cuota ${cuota.installmentNumber} tiene pagado (${cuota.paidPesos}) más que su total ` +
          `(${cuota.totalPesos}): datos corruptos, no se recalcula el saldo`,
      );
    }
    outstandingPesos = add(outstandingPesos, balance);
    if (balance > 0) {
      unpaid.push({ installmentNumber: cuota.installmentNumber, dueDate: cuota.dueDate, balancePesos: balance });
    }
  }

  if (outstandingPesos === 0) {
    return { outstandingPesos: 0, daysPastDue: 0, delinquencyStatus: DelinquencyStatus.PAID };
  }

  let daysPastDue = 0;
  let next: UnpaidInstallment | null = null;
  for (const cuota of unpaid) {
    const atraso = daysPastDueForInstallment(cuota, today);
    if (atraso > daysPastDue) daysPastDue = atraso;
    if (next === null || toMillis(cuota.dueDate) < toMillis(next.dueDate)) {
      next = cuota;
    }
  }

  // El estado mira la **próxima cuota impaga** sobre una línea de días relativa a su vencimiento:
  // si ya venció (delta >= 0) se clasifica por atraso; si vence hoy, DUE_TODAY; si está por
  // venir dentro de la ventana de aviso, DUE_SOON; el resto es CURRENT.
  const delta = next === null ? 0 : wholeDaysBetween(next.dueDate, today);
  let delinquencyStatus: DelinquencyStatus;
  if (delta >= config.defaultDays) {
    delinquencyStatus = DelinquencyStatus.DEFAULT;
  } else if (delta >= config.overdueDays) {
    delinquencyStatus = DelinquencyStatus.OVERDUE;
  } else if (delta === 0) {
    delinquencyStatus = DelinquencyStatus.DUE_TODAY;
  } else if (-delta <= config.dueSoonDays) {
    delinquencyStatus = DelinquencyStatus.DUE_SOON;
  } else {
    delinquencyStatus = DelinquencyStatus.CURRENT;
  }

  return { outstandingPesos, daysPastDue, delinquencyStatus };
}

/** ==================== cartera ==================== */

/** Los seis estados, en el orden en que se muestran al admin (de menos a más tarde). */
export const DELINQUENCY_STATUSES: readonly DelinquencyStatus[] = [
  DelinquencyStatus.CURRENT,
  DelinquencyStatus.DUE_SOON,
  DelinquencyStatus.DUE_TODAY,
  DelinquencyStatus.OVERDUE,
  DelinquencyStatus.DEFAULT,
  DelinquencyStatus.PAID,
];

export interface PortfolioSummary {
  /** Préstamos con al menos una cuota impaga (los recalculados bien). */
  loans: number;
  /** Saldo por cobrar de toda la cartera: lo que falta de los préstamos activos. */
  outstandingPesos: number;
  /** Saldo ya vencido: `OVERDUE` + `DEFAULT`. */
  overduePesos: number;
  /** Saldo en incumplimiento: `DEFAULT` (a partir del umbral de `defaultDays`). */
  inDefaultPesos: number;
  /** Saldo que vence hoy o en la ventana de aviso: `DUE_TODAY` + `DUE_SOON`. */
  dueSoonPesos: number;
  /** Mayor atraso de la cartera, en días. */
  maxDaysPastDue: number;
  byStatus: Record<DelinquencyStatus, number>;
}

export interface DelinquencySummaryEntry {
  recalc: LoanDelinquencyResult;
}

/**
 * Resumen de la cartera a partir de los recálculos (PROJECT_SPEC §13, definiciones de "vencida" y
 * "en mora").
 *
 * Sumapesos enteros con `add`: la cartera son decenas de préstamos y cada saldo ya viene
 * validado por `sub`, así que la suma también tiene que quedar entera y segura.
 */
export function summarizeDelinquency(
  entries: readonly DelinquencySummaryEntry[],
): PortfolioSummary {
  const byStatus = {
    CURRENT: 0,
    DUE_SOON: 0,
    DUE_TODAY: 0,
    OVERDUE: 0,
    DEFAULT: 0,
    PAID: 0,
  } as Record<DelinquencyStatus, number>;

  let outstandingPesos = 0;
  let overduePesos = 0;
  let inDefaultPesos = 0;
  let dueSoonPesos = 0;
  let maxDaysPastDue = 0;
  let loans = 0;

  for (const { recalc } of entries) {
    byStatus[recalc.delinquencyStatus] += 1;
    if (recalc.delinquencyStatus === DelinquencyStatus.PAID) continue;
    loans += 1;
    outstandingPesos = add(outstandingPesos, recalc.outstandingPesos);
    if (recalc.daysPastDue > maxDaysPastDue) maxDaysPastDue = recalc.daysPastDue;
    if (
      recalc.delinquencyStatus === DelinquencyStatus.OVERDUE ||
      recalc.delinquencyStatus === DelinquencyStatus.DEFAULT
    ) {
      overduePesos = add(overduePesos, recalc.outstandingPesos);
    }
    if (recalc.delinquencyStatus === DelinquencyStatus.DEFAULT) {
      inDefaultPesos = add(inDefaultPesos, recalc.outstandingPesos);
    }
    if (
      recalc.delinquencyStatus === DelinquencyStatus.DUE_SOON ||
      recalc.delinquencyStatus === DelinquencyStatus.DUE_TODAY
    ) {
      dueSoonPesos = add(dueSoonPesos, recalc.outstandingPesos);
    }
  }

  return {
    loans,
    outstandingPesos,
    overduePesos,
    inDefaultPesos,
    dueSoonPesos,
    maxDaysPastDue,
    byStatus,
  };
}
