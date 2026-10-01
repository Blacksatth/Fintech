"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Descripción accesible (texto, nunca color solo). Se enlaza con `aria-describedby`. */
  description?: ReactNode;
  children?: ReactNode;
  /** Pie con acciones (ej. los Buttons de confirmar/cancelar). */
  footer?: ReactNode;
  className?: string;
  size?: "md" | "lg";
}

const sizeClasses: Record<NonNullable<ModalProps["size"]>, string> = {
  md: "max-w-md",
  lg: "max-w-2xl",
};

/**
 * Diálogo accesible: `role="dialog"` + `aria-modal`, `aria-labelledby` al título y
 * `aria-describedby` a la descripción, focus trap con Tab/Shift+Tab, cierre con Escape y
 * click en el fondo. Se renderiza por portal al `document.body` y bloquea el scroll del body.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  size = "md",
}: ModalProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      prevActive?.focus?.();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return createPortal(
    <div
      data-slot="modal-backdrop"
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-ink/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        data-slot="modal-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className={cn(
          // `max-h` + `overflow` en el cuerpo: sin esto un diálogo con mucho contenido (los cuatro
          // canales de pago, el calendario de un préstamo) crece más que la ventana, el pie con los
          // botones queda por debajo del borde y **no hay forma de enviarlo**. El fondo también
          // scrollea para que en pantallas bajas el panel no se corte por arriba.
          "flex max-h-[100dvh] w-full flex-col rounded-lg border border-border-strong bg-surface shadow-popover focus:outline-none sm:max-h-[calc(100dvh-2rem)] sm:rounded-lg",
          sizeClasses[size],
          className,
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-1 text-sm text-ink-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Cerrar diálogo"
            onClick={onClose}
            className="rounded-md p-1 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <span aria-hidden className="text-lg leading-none">×</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
