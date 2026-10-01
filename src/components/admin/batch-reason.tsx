"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Input } from "@/components/ui";

/**
 * Motivo único por tanda de configuración (F13-2b).
 *
 * Pedir el motivo en cada formulario obligaba a escribirlo hasta doce veces para un mismo ajuste
 * ("subimos la tasa y los montos de los tiers"), y la auditoría recibía doce textos casi idénticos
 * que después no se pueden distinguir. Aquí el motivo se escribe **una vez** y todas las guardas de
 * esa visita lo heredan.
 *
 * No es "quitar la obligatoriedad": la regla de negocio sigue intacta y el motivo sigue yendo en
 * `audit_logs.metadata.reason` de cada cambio. Lo que cambia es la fricción —un campo en lugar de
 * uno por formulario— y se mantiene visible el motivo con el que se está guardando.
 *
 * Vive en `sessionStorage` para que sobreviva a un `router.refresh()` o a un F5 a mitad de la tanda:
 * perder el motivo por un refresco significa perder el trabajo que el admin ya escribió.
 */

const CLAVE = "admin.config.batchReason";
const MINIMO = 3;

interface BatchReasonValue {
  reason: string;
  setReason: (value: string) => void;
  /** Cambios guardados con este motivo desde que se abrió la tanda. */
  savedCount: number;
  registerSave: () => void;
  /** Cierra la tanda: limpia el motivo y el contador para empezar de cero. */
  resetBatch: () => void;
}

const BatchReasonContext = createContext<BatchReasonValue | null>(null);

/**
 * El motivo guardado como estado externo, no dentro del provider.
 *
 * `useState(() => ...)` leyendo `sessionStorage` correría también durante el render del servidor,
 * donde `window` no existe. Y leerlo en un `useEffect` obliga a un segundo render (el primero
 * pintaría un motivo vacío aunque hubiera uno a media tanda). `useSyncExternalStore` resuelve las dos
 * cosas: snapshot de servidor siempre vacío, y en el cliente el valor real sin render extra.
 */
const oyentes = new Set<() => void>();

function leerGuardado(): string {
  try {
    return window.sessionStorage.getItem(CLAVE) ?? "";
  } catch {
    // Modo privado o almacenamiento bloqueado: la tanda vive solo en memoria, que es el mismo
    // comportamiento que antes y no vale la pena romper la pantalla por ello.
    return "";
  }
}

function escribirGuardado(value: string): void {
  try {
    if (value) window.sessionStorage.setItem(CLAVE, value);
    else window.sessionStorage.removeItem(CLAVE);
  } catch {
    // Igual que arriba: sin persistencia, pero el motivo sigue en pantalla.
  }
}

function suscribir(oyente: () => void): () => void {
  oyentes.add(oyente);
  return () => {
    oyentes.delete(oyente);
  };
}

function avisar(): void {
  for (const oyente of oyentes) oyente();
}

function useMotivoGuardado(): [string, (value: string) => void] {
  const motivo = useSyncExternalStore(
    suscribir,
    leerGuardado,
    () => "",
  );

  const fijar = useCallback((value: string) => {
    escribirGuardado(value);
    avisar();
  }, []);

  return [motivo, fijar];
}

export function BatchReasonProvider({ children }: { children: ReactNode }) {
  const [reason, setReason] = useMotivoGuardado();
  const [savedCount, setSavedCount] = useState(0);

  const resetBatch = useCallback(() => {
    setReason("");
    setSavedCount(0);
    try {
      window.sessionStorage.removeItem(CLAVE);
    } catch {
      // sin persistencia no hay nada que limpiar
    }
  }, []);

  const value = useMemo<BatchReasonValue>(
    () => ({
      reason,
      setReason,
      savedCount,
      registerSave: () => setSavedCount((n) => n + 1),
      resetBatch,
    }),
    [reason, setReason, savedCount, resetBatch],
  );

  return <BatchReasonContext.Provider value={value}>{children}</BatchReasonContext.Provider>;
}

/**
 * El motivo de la tanda. Se usa dentro de `BatchReasonProvider`; fuera de él devuelve un valor
 * vacío en vez de lanzar, para que un formulario de configuración reutilizable siga renderizando.
 */
export function useBatchReason(): BatchReasonValue {
  const context = useContext(BatchReasonContext);
  return context ?? { reason: "", setReason: () => {}, savedCount: 0, registerSave: () => {}, resetBatch: () => {} };
}

/** `true` cuando el motivo ya tiene largo suficiente para guardarse. */
export function isReasonReady(reason: string): boolean {
  return reason.trim().length >= MINIMO;
}

export const REASON_MIN_LENGTH = MINIMO;

/**
 * Barra fija del motivo: se escribe una vez y todas las secciones la usan.
 *
 * `sticky` para que siga a la vista mientras se baja por los formularios, que es justo cuando el
 * admin necesita confirmar con qué está guardando.
 */
export function BatchReasonBar() {
  const { reason, setReason, savedCount, resetBatch } = useBatchReason();
  const listo = isReasonReady(reason);

  return (
    <section
      aria-label="Motivo de la tanda de cambios"
      className="sticky top-16 z-20 rounded-lg border border-border bg-surface p-4 shadow-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">Motivo de esta tanda de cambios</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Se aplica a todo lo que guardes ahora. Queda en la auditoría con cada cambio.
            {savedCount > 0
              ? ` ${savedCount} cambio${savedCount === 1 ? "" : "s"} guardado${savedCount === 1 ? "" : "s"} con este motivo.`
              : ""}
          </p>
          <div className="mt-2">
            <Input
              id="batch-reason"
              label="Motivo del cambio"
              hint="Ej. ajuste aprobado por comité de riesgos del 12/09"
              placeholder="Escribe el motivo una vez"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="w-full"
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            data-slot="batch-reason-state"
            className={
              listo
                ? "rounded-full bg-success-bg px-2 py-1 text-xs font-medium text-success"
                : "rounded-full bg-warning-bg px-2 py-1 text-xs font-medium text-warning"
            }
          >
            {listo ? "Listo para guardar" : `Mínimo ${MINIMO} caracteres`}
          </span>
          {savedCount > 0 || reason ? (
            <button
              type="button"
              onClick={resetBatch}
              className="rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
            >
              Cerrar tanda
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}