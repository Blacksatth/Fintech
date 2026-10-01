"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export type ToastTone = "neutral" | "success" | "danger" | "info";

export interface ToastItem {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (tone: ToastTone, title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Hook del sistema: `const { toast } = useToast();` — SIEMPRE medio del Provider. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast debe usarse dentro de <ToastProvider>");
  }
  return ctx;
}

const toneIcon: Record<ToastTone, ReactNode> = {
  neutral: <span aria-hidden className="text-2xl leading-none">💡</span>,
  success: <span aria-hidden className="text-2xl leading-none">✓</span>,
  danger: <span aria-hidden className="text-2xl leading-none">✕</span>,
  info: <span aria-hidden className="text-2xl leading-none">ℹ</span>,
};

/** El ítem se anuncia solo con TEXT (título siempre presente; el icono es decorativo aria-hidden). */
function ToneDecorator({ tone }: { tone: ToastTone }) {
  return <span aria-hidden className="grid shrink-0 place-items-center">{toneIcon[tone]}</span>;
}

function ToastViewport({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6">
      {items.map((item) => (
        <div
          key={item.id}
          role={item.tone === "danger" ? "alert" : "status"}
          aria-live={item.tone === "danger" ? "assertive" : "polite"}
          className={cn(
            "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-surface p-3 shadow-popover sm:w-auto",
            item.tone === "danger" && "border-danger",
          )}
        >
          <ToneDecorator tone={item.tone} />
          <div className="flex-1">
            <p className="text-sm font-medium text-ink">{item.title}</p>
            {item.description ? <p className="mt-0.5 text-xs text-ink-muted">{item.description}</p> : null}
          </div>
          <button
            type="button"
            aria-label="Cerrar notificación"
            onClick={() => onDismiss(item.id)}
            className="rounded text-ink-subtle transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

const subscribeNever = () => () => {};

/** `false` durante SSR y la hidratación, `true` después: el portal nunca se anticipa al HTML. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

/**
 * Sistema de notificaciones. A11y: `role="status"` para info/sucess y `role="alert"` para danger,
 * con `aria-live="polite"`/`assertive`. Se auto-descarta a los 4s salvo danger.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const mounted = useHydrated();
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (tone: ToastTone, title: string, description?: string) => {
      const id = crypto.randomUUID();
      setItems((prev) => [...prev, { id, tone, title, description }]);
      if (tone !== "danger") {
        timersRef.current.set(
          id,
          setTimeout(() => dismiss(id), 4000),
        );
      }
    },
    [dismiss],
  );

  const value = { toast };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted ? createPortal(<ToastViewport items={items} onDismiss={dismiss} />, document.body) : null}
    </ToastContext.Provider>
  );
}
