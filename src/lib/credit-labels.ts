import { format } from "date-fns";
import { es } from "date-fns/locale";
import { type ApplicationStatus, type DelinquencyStatus, type DisbursementStatus, type InstallmentStatus, type LoanStatus, type PaymentStatus, type TermFrequency } from "@/server/types";
import { type BadgeTone } from "@/components/ui/badge";

/**
 * Presentación compartida de crédito (estado, frecuencia, fechas). Antes vivía
 * duplicado en tres componentes; aquí es la única fuente para servidor y cliente.
 */

export const applicationStatusLabels: Record<ApplicationStatus, string> = {
  DRAFT: "Borrador",
  SUBMITTED: "Presentada",
  UNDER_REVIEW: "En revisión",
  APPROVED: "Aprobada",
  REJECTED: "Rechazada",
};

export const applicationStatusTones: Record<ApplicationStatus, BadgeTone> = {
  DRAFT: "neutral",
  SUBMITTED: "primary",
  UNDER_REVIEW: "info",
  APPROVED: "success",
  REJECTED: "danger",
};

/** Estados desde los que un ADMIN puede decidir (no Includes nada: es la máquina de estados). */
export const DECIDABLE_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  "SUBMITTED",
  "UNDER_REVIEW",
];

export function isDecidableStatus(status: ApplicationStatus): boolean {
  return DECIDABLE_APPLICATION_STATUSES.includes(status);
}

export function applicationStatusLabel(status: ApplicationStatus): string {
  return applicationStatusLabels[status] ?? status;
}

export function applicationStatusTone(status: ApplicationStatus): BadgeTone {
  return applicationStatusTones[status] ?? "neutral";
}

export const loanStatusLabels: Record<LoanStatus, string> = {
  PENDING_DISBURSEMENT: "Pendiente de desembolso",
  DISBURSED: "Desembolsado",
  PAID: "Pagado",
  DEFAULTED: "En mora",
  WRITTEN_OFF: "Cartera castigada",
};

export const loanStatusTones: Record<LoanStatus, BadgeTone> = {
  PENDING_DISBURSEMENT: "info",
  DISBURSED: "primary",
  PAID: "success",
  DEFAULTED: "danger",
  WRITTEN_OFF: "neutral",
};

export const installmentStatusLabels: Record<InstallmentStatus, string> = {  PENDING: "Pendiente",
  PAID: "Pagada",
};

export const disbursementStatusLabels: Record<DisbursementStatus, string> = {
  PENDING: "Sin iniciar",
  INITIATED: "Iniciado, falta confirmar",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
};

export const disbursementStatusTones: Record<DisbursementStatus, BadgeTone> = {
  PENDING: "neutral",
  INITIATED: "warning",
  CONFIRMED: "success",
  CANCELLED: "danger",
};

export function disbursementStatusLabel(status: DisbursementStatus | null | undefined): string {
  if (!status) return disbursementStatusLabels.PENDING;
  return disbursementStatusLabels[status] ?? status;
}

export function disbursementStatusTone(status: DisbursementStatus | null | undefined): BadgeTone {
  if (!status) return disbursementStatusTones.PENDING;
  return disbursementStatusTones[status] ?? "neutral";
}

export const installmentStatusTones: Record<InstallmentStatus, BadgeTone> = {
  PENDING: "warning",
  PAID: "success",
};

export const delinquencyStatusLabels: Record<DelinquencyStatus, string> = {
  CURRENT: "Al día",
  DUE_SOON: "Por vencer",
  DUE_TODAY: "Vence hoy",
  OVERDUE: "Vencida",
  DEFAULT: "En mora",
  PAID: "Saldada",
};

export const delinquencyStatusTones: Record<DelinquencyStatus, BadgeTone> = {
  CURRENT: "success",
  DUE_SOON: "warning",
  DUE_TODAY: "warning",
  OVERDUE: "danger",
  DEFAULT: "danger",
  PAID: "neutral",
};

export function loanStatusLabel(status: LoanStatus): string {
  return loanStatusLabels[status] ?? status;
}

export function loanStatusTone(status: LoanStatus): BadgeTone {
  return loanStatusTones[status] ?? "neutral";
}

export function installmentStatusLabel(status: InstallmentStatus): string {
  return installmentStatusLabels[status] ?? status;
}

export function installmentStatusTone(status: InstallmentStatus): BadgeTone {
  return installmentStatusTones[status] ?? "warning";
}

export function delinquencyStatusLabel(status: DelinquencyStatus): string {
  return delinquencyStatusLabels[status] ?? status;
}

export function delinquencyStatusTone(status: DelinquencyStatus): BadgeTone {
  return delinquencyStatusTones[status] ?? "neutral";
}

/**
 * Estado de un pago, en palabras que un humano pueda usar sin saber el nombre técnico.
 *
 * `PENDING` no se llama "pendiente" a secas: la etiqueta deja claro que **nadie ha revisado el
 * dinero todavía**, que es la diferencia entre un pago registrado y un pago pagado.
 */
export const paymentStatusLabels: Record<PaymentStatus, string> = {
  PENDING: "Registrado, falta revisión",
  CONFIRMED: "Confirmado",
  REJECTED: "Rechazado",
  REVERSED: "Revertido",
};

export const paymentStatusTones: Record<PaymentStatus, BadgeTone> = {
  PENDING: "warning",
  CONFIRMED: "success",
  REJECTED: "danger",
  REVERSED: "neutral",
};

export function paymentStatusLabel(status: PaymentStatus): string {
  return paymentStatusLabels[status] ?? status;
}

export function paymentStatusTone(status: PaymentStatus): BadgeTone {
  return paymentStatusTones[status] ?? "neutral";
}

/**
 * Tipo de aviso, en palabras. El mapa es por código y no por orden: solo los dos tipos del MVP
 * (F11); los que lleguen con F15-1 se van agregando aquí, que es la única fuente para UI.
 */
export const notificationTypeLabels: Record<string, string> = {
  INSTALLMENT_DUE_SOON: "Cuota próxima",
  INSTALLMENT_OVERDUE: "Cuota vencida",
};

export function notificationTypeLabel(type: string | undefined | null): string {
  if (!type) return "Aviso";
  return notificationTypeLabels[type] ?? type;
}

/**
 * `payments.channel` guarda el **id** del canal, que por construcción es su `type`
 * (`paymentChannelDocId(type) === type`). Mostrar `NEQUI` en una tabla para una clienta es peor que
 * no mostrar nada, así que se traduce; si algún día aparece un canal que no esté en el mapa se
 * muestra el código tal cual, que al menos es honesto.
 */
export const paymentChannelLabels: Record<string, string> = {
  BANK_TRANSFER: "Transferencia bancaria",
  NEQUI: "Nequi",
  QR: "Código QR",
  BREB: "Bre-B (ventanilla)",
};

export function paymentChannelLabel(channel: string): string {
  return paymentChannelLabels[channel] ?? channel;
}

export function termFrequencyLabel(frequency: TermFrequency): string {
  switch (frequency) {
    case "WEEKLY":
      return "Semanal";
    case "BIWEEKLY":
      return "Quincenal";
    case "MONTHLY":
      return "Mensual";
    default:
      return frequency;
  }
}

export const monthlyIncomeLabels: Record<string, string> = {
  "0-1M": "Hasta $1M",
  "1M-2M": "Entre $1M y $2M",
  "2M-4M": "Entre $2M y $4M",
  "4M-8M": "Entre $4M y $8M",
  "8M+": "Más de $8M",
};

export function monthlyIncomeLabel(range: string | undefined): string | null {
  if (!range) return null;
  return monthlyIncomeLabels[range] ?? range;
}

type DateLike = Date | { toMillis: () => number } | string | number | null | undefined;

/** Normaliza lo que devuelve Firestore (`Timestamp`), JSON y `Date` a `Date`. */
export function toDate(value: DateLike): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  if (typeof value === "string") {
    const fromString = new Date(value);
    return Number.isNaN(fromString.getTime()) ? null : fromString;
  }
  try {
    const fromMillis = new Date(value.toMillis());
    return Number.isNaN(fromMillis.getTime()) ? null : fromMillis;
  } catch {
    return null;
  }
}

const DATE_TIME_FORMAT = "dd/MM/yyyy HH:mm";
const DUE_DATE_FORMATTER = new Intl.DateTimeFormat("es-CO", {
  timeZone: "UTC",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** Fecha legible; devuelve el fallback si el valor no es una fecha válida. */
export function formatDateTime(value: DateLike, fallback = "—"): string {
  const date = toDate(value);
  if (!date) return fallback;
  try {
    return format(date, DATE_TIME_FORMAT, { locale: es });
  } catch {
    return fallback;
  }
}

/**
 * Vencimiento de cuota, SIEMPRE en UTC.
 *
 * El calendario se calcula en UTC (ver `addPeriods`), así que un vencimiento es la medianoche
 * de un día concreto. Formatearlo en la zona del navegador lo correría un día: en Colombia
 * (UTC-5) el 24/03/2026T00:00Z se mostraría como "23/03/2026 19:00", que es la fecha que ve
 * el cliente y no la que se pactó.
 *
 * Se arma con `formatToParts` en vez de `format` para que el separador no dependa de la
 * versión de ICU del runtime; date-fns v4 no acepta `timeZone` en `format`.
 */
export function formatDueDate(value: DateLike, fallback = "—"): string {
  const date = toDate(value);
  if (!date) return fallback;
  try {
    const parts = DUE_DATE_FORMATTER.formatToParts(date);
    const pick = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    return `${pick("day")}/${pick("month")}/${pick("year")}`;
  } catch {
    return fallback;
  }
}

/** Recorta un id de Firebase para mostrarlo sin occupy la tabla. */
export function shortUid(uid: string | undefined | null): string {
  if (!uid) return "—";
  return uid.length <= 10 ? uid : `${uid.slice(0, 8)}…`;
}

/**
 * Tasas en basis points → texto legible: `2400` → `"24 %"`, `200` → `"2 %"`, `345` → `"3,45 %"`.
 *
 * Vive aquí para que tasa, panel y cotización no inventen su propia conversión (y no acaben
 * enseñando `0.24` o `2400` al cliente). `formatRateBps` es el entero sin decimales;
 * `formatRateBpsPrecise` conserva dos decimales para tasas pequeñas como la mensual.
 */
export function formatRateBps(bps: number): string {
  return `${(Math.round(bps) / 100).toLocaleString("es-CO", { maximumFractionDigits: 0 })} %`;
}

/** Igual que `formatRateBps` pero sin perder decimales: `200` → `"2 %"`, `233` → `"2,33 %"`. */
export function formatRateBpsPrecise(bps: number): string {
  return `${(Math.round(bps) / 100).toLocaleString("es-CO", { maximumFractionDigits: 2 })} %`;
}
