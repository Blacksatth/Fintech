import { cn } from "@/lib/cn";
import { formatPesos } from "@/server/money";

export type StatTone = "neutral" | "primary" | "success" | "danger" | "warning";

export interface StatProps {
  /** Label corto (ej. "Capital desembolsado"). */
  label: string;
  /** Valor principal — SIEMPRE en pesos enteros (formatPesos). */
  valuePesos: number;
  /** Detalle semántico corto, SIEMPRE texto (nunca color solo). */
  meta?: string;
  /** Tono del acento; el label/texto nunca depende de color para comunicar. */
  tone?: StatTone;
  className?: string;
}

const accentByTone: Record<StatTone, string> = {
  neutral: "bg-border-strong",
  primary: "bg-primary-500",
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
};

/**
 * Indicador numérico de pesos enteros con acento de estado. A11y: el label SIEMPRE está en texto
 * (nunca color solo); el valor sale con `formatPesos` (COP entero, es-CO).
 */
export function Stat({ label, valuePesos, meta, tone = "neutral", className }: StatProps) {
  return (
    <div
      data-slot="stat"
      className={cn("relative overflow-hidden rounded-lg border border-border bg-surface p-4 pr-6", className)}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", accentByTone[tone])} />
      <div className="flex flex-col gap-1 pl-1.5">
        <p className="text-sm text-ink-muted">{label}</p>
        <p className="text-2xl font-semibold tabular-nums text-ink">{formatPesos(valuePesos)}</p>
        {meta ? <p className="text-xs text-ink-subtle">{meta}</p> : null}
      </div>
    </div>
  );
}
