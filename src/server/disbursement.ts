import { assertScheduleIsBalanced, buildLoanSchedule } from "@/server/schedule";
import {
  DisbursementStatus,
  InstallmentStatus,
  TermFrequency,
} from "@/server/types";
import type {
  DisbursementDoc,
  LoanInstallmentDoc,
  LoanPricingSnapshot,
} from "@/server/credit-doc";

/**
 * Dominio de desembolso (PROJECT_SPEC §12). Puro: sin Firebase ni Next, para que la
 * máquina de estados sea testeable sin infraestructura.
 *
 * El dinero del préstamo se congela al aprobar (PROJECT_SPEC §8.1 `loans.pricing`); aquí
 * solo se programa **cuándo** se vence cada cuota, nunca **cuánto** se debe.
 */

const MAX_REFERENCE_LENGTH = 120;

export interface DisbursementInitiation {
  loanId: string;
  initiatedBy: string;
  initiatedAt: Date;
  /** `Idempotency-Key` del inicio. Se guarda en el doc como trazabilidad. */
  idempotencyKey: string;
  /** Referencia de la transferencia, si el admin ya la tiene al iniciar. */
  reference?: string;
}

export interface DisbursementConfirmation {
  /** Sobrescribe la referencia registrada al iniciar si viene. */
  reference?: string;
  confirmedBy: string;
  confirmedAt: Date;
}

export interface RescheduledInstallment {
  installmentNumber: number;
  dueDate: Date;
}

/**
 * Interfaz honesta: describe lo que un proveedor de desembolso sabe hacer, no lo que
 * haría "un banco". Hoy la única implementación es manual (el admin transfiere y
 * declara la referencia), y no simula ni una llamada de red.
 */
export interface DisbursementProvider {
  readonly name: "manual";
  /** Crea/avanza el doc a INITIATED. Lanza si ya existe un desembolso. */
  initiate(current: DisbursementDoc | null, input: DisbursementInitiation): DisbursementDoc;
  /** INITIATED → CONFIRMED. Lanza si falta referencia o confirmación humana. */
  confirm(current: DisbursementDoc, input: DisbursementConfirmation): DisbursementDoc;
}

export class ManualDisbursementError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "ManualDisbursementError";
    this.statusCode = statusCode;
  }
}

function normalizeReference(reference: string | undefined, required: boolean): string | undefined {
  const trimmed = reference?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    if (required) {
      throw new ManualDisbursementError(
        "Falta la referencia del desembolso: no se puede confirmar sin ella",
      );
    }
    return undefined;
  }
  if (trimmed.length > MAX_REFERENCE_LENGTH) {
    throw new ManualDisbursementError(
      `La referencia no puede superar ${MAX_REFERENCE_LENGTH} caracteres`,
    );
  }
  return trimmed;
}

function requireActor(actor: string | undefined, what: string): string {
  const trimmed = actor?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new ManualDisbursementError(
      `Falta la identificación del actor: no se puede ${what} sin confirmación humana identificable`,
    );
  }
  return trimmed;
}

function assertDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ManualDisbursementError(`${field} inválida`);
  }
  return value;
}

export class ManualDisbursementProvider implements DisbursementProvider {
  readonly name = "manual" as const;

  initiate(current: DisbursementDoc | null, input: DisbursementInitiation): DisbursementDoc {
    if (current !== null) {
      throw new ManualDisbursementError(
        `El préstamo ya tiene un desembolso en estado ${current.status}: no se puede iniciar otro`,
      );
    }
    const initiatedAt = assertDate(input.initiatedAt, "initiatedAt");
    return {
      loanId: input.loanId,
      provider: "manual",
      status: DisbursementStatus.INITIATED,
      reference: normalizeReference(input.reference, false),
      initiatedBy: requireActor(input.initiatedBy, "iniciar el desembolso"),
      initiatedAt,
      idempotencyKey: input.idempotencyKey,
    };
  }

  confirm(current: DisbursementDoc, input: DisbursementConfirmation): DisbursementDoc {
    if (current.status === DisbursementStatus.CONFIRMED) {
      throw new ManualDisbursementError(
        "El desembolso ya está confirmado: no se puede confirmar dos veces",
      );
    }
    if (current.status !== DisbursementStatus.INITIATED) {
      throw new ManualDisbursementError(
        `No se puede confirmar un desembolso en estado ${current.status}: debe estar en INITIATED`,
      );
    }
    const reference = normalizeReference(input.reference ?? current.reference, true);
    return {
      ...current,
      status: DisbursementStatus.CONFIRMED,
      reference,
      confirmedBy: requireActor(input.confirmedBy, "confirmar el desembolso"),
      confirmedAt: assertDate(input.confirmedAt, "confirmedAt"),
    };
  }
}

/** Instancia única: el proveedor manual es stateless. */
export const manualDisbursementProvider = new ManualDisbursementProvider();

function asFrequency(value: string | undefined): TermFrequency {
  const frequency = Object.values(TermFrequency).find((candidato) => candidato === value);
  if (frequency === undefined) {
    throw new ManualDisbursementError(
      `Frecuencia de plazo desconocida en el snapshot de pricing: ${String(value)}`,
    );
  }
  return frequency;
}

/**
 * Recalcula los vencimientos desde la fecha real de desembolso usando el snapshot
 * congelado del préstamo.
 *
 * Decisión de diseño (F9): devuelve **solo** `{installmentNumber, dueDate}`. El servicio
 * escribe únicamente esos dos campos sobre las cuotas existentes, así que re-programar el
 * calendario no puede alterar ni un peso de los importes ya aceptados por el cliente, y
 * una cuota ya pagada conserva su vencimiento histórico.
 */
export function rescheduleDueDates(
  installments: readonly LoanInstallmentDoc[],
  disbursedAt: Date,
  pricing: LoanPricingSnapshot | undefined,
): RescheduledInstallment[] {
  if (pricing === undefined) {
    throw new ManualDisbursementError(
      "El préstamo no tiene snapshot de pricing: no se puede recalcular el calendario. " +
        "Requiere migración de datos, no un recálculo con la tasa vigente",
    );
  }
  if (installments.length === 0) {
    throw new ManualDisbursementError("El préstamo no tiene cuotas: no hay calendario que recalcular");
  }
  if (installments.length !== pricing.termInstallments) {
    throw new ManualDisbursementError(
      `El préstamo declara ${pricing.termInstallments} cuotas en su snapshot pero tiene ${installments.length}: datos inconsistentes`,
    );
  }
  const numbers = installments.map((cuota) => cuota.installmentNumber);
  const ordenadas = [...numbers].sort((a, b) => a - b);
  if (ordenadas[0] !== 1 || ordenadas[ordenadas.length - 1] !== installments.length) {
    throw new ManualDisbursementError(
      "Las cuotas del préstamo no están numeradas de 1 a N: no se puede recalcular el calendario",
    );
  }

  const schedule = buildLoanSchedule({
    principalPesos: installments.reduce(
      (acc, cuota) => acc + cuota.principalPesos,
      0,
    ),
    annualRateBps: pricing.annualRateBps,
    effectiveFeeBps: pricing.effectiveFeeBps,
    termInstallments: pricing.termInstallments,
    termFrequency: asFrequency(pricing.termFrequency),
    disbursementDate: assertDate(disbursedAt, "disbursedAt"),
  });
  // Red de seguridad: si el plan no cuadra, no se re-programa nada.
  assertScheduleIsBalanced(schedule);

  const porNumero = new Map(schedule.installments.map((cuota) => [cuota.installmentNumber, cuota]));
  return installments
    .filter((cuota) => cuota.status !== InstallmentStatus.PAID)
    .map((cuota) => {
      const reprogramada = porNumero.get(cuota.installmentNumber);
      if (reprogramada === undefined) {
        throw new ManualDisbursementError(
          `No se pudo reprogramar la cuota ${cuota.installmentNumber}: el plan no la contiene`,
        );
      }
      return { installmentNumber: cuota.installmentNumber, dueDate: reprogramada.dueDate };
    })
    .sort((a, b) => a.installmentNumber - b.installmentNumber);
}
