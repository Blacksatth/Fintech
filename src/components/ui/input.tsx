import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label?: string;
  hint?: ReactNode;
  error?: string;
  /** Prefijo visible dentro del campo (ej. el símbolo de la moneda, "$"). */
  prefix?: ReactNode;
  /** Si true, el label NO es visible pero sigue presente para lectores de pantalla. */
  hideLabel?: boolean;
}

/**
 * Campo de entrada con label + hint + error. A11y: `id` propio, `aria-invalid`,
 * `aria-describedby` apuntando a hint/error. El error nunca se comunica solo con color.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, prefix, hideLabel = false, className, id, disabled, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <label
          htmlFor={inputId}
          className={cn("text-sm font-medium text-ink", hideLabel && "sr-only")}
        >
          {label}
        </label>
      ) : null}
      <div className="relative">
        {prefix ? (
          <span
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-ink-muted"
          >
            {prefix}
          </span>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle",
            "transition-colors duration-150",
            "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-subtle",
            "focus:border-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-600/20",
            prefix ? "pl-8" : undefined,
            error && "border-danger focus:border-danger focus:ring-danger/20",
            className,
          )}
          {...props}
        />
      </div>
      {hint && !error ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
});
