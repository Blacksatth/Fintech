import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Remove icon → must include the label text. */
  removable?: boolean;
  onRemove?: () => void;
  /**
   * A11y: label corto mostrado junto al texto (ej. cuota "8/12"). NUNCA pintar un Badge
   * con SOLO color: el texto siempre está, y si el único contenido es color/icono, usa
   * `aria-label` para que los lectores de pantalla lo entiendan.
   */
  "aria-label"?: string;
}

const toneClasses: Record<BadgeTone, string> = {
  neutral: "bg-surface-muted text-ink border-border-strong",
  primary: "bg-primary-50 text-primary-900 border-primary-200",
  success: "bg-success-bg text-success border-success/20",
  warning: "bg-warning-bg text-warning border-warning/30",
  danger: "bg-danger-bg text-danger border-danger/30",
  info: "bg-info-bg text-info border-info/30",
};

export function Badge({ tone = "neutral", removable, onRemove, className, children, ...props }: BadgeProps) {
  return (
    <span
      aria-label={props["aria-label"]}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      {removable && onRemove ? (
        <button
          type="button"
          aria-label="Quitar"
          onClick={onRemove}
          className="rounded-full p-0.5 hover:bg-current/10 focus-visible:outline-2 focus-visible:outline-offset-1"
        >
          ×
        </button>
      ) : null}
      {children}
    </span>
  );
}
