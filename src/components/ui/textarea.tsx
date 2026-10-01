import {
  forwardRef,
  useId,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "prefix"> {
  label?: string;
  hint?: ReactNode;
  error?: string;
  /** Si true, el label NO es visible pero sigue presente para lectores de pantalla. */
  hideLabel?: boolean;
}

/**
 * Área de texto con label + hint + error, con la misma accesibilidad que `Input`:
 * `id` propio, `aria-invalid` y `aria-describedby` apuntando a hint/error.
 * El error nunca se comunica solo con color.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, hideLabel = false, className, id, disabled, rows = 4, ...props },
  ref,
) {
  const autoId = useId();
  const textareaId = id ?? autoId;
  const hintId = hint ? `${textareaId}-hint` : undefined;
  const errorId = error ? `${textareaId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <label
          htmlFor={textareaId}
          className={cn("text-sm font-medium text-ink", hideLabel && "sr-only")}
        >
          {label}
        </label>
      ) : null}
      <textarea
        ref={ref}
        id={textareaId}
        rows={rows}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle",
          "transition-colors duration-150",
          "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-subtle",
          "focus:border-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-600/20",
          error && "border-danger focus:border-danger focus:ring-danger/20",
        )}
        {...props}
      />
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
