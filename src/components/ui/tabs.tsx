"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabPanel {
  id: string;
  label: string;
  /** Contador opcional (pendientes de revisar). Se muestra como texto, nunca solo con color. */
  badge?: number;
  content: ReactNode;
}

export interface TabsProps {
  panels: TabPanel[];
  /** Panel activo. Lo controla quien renderiza, para poder reflejarlo en la URL si hace falta. */
  value: string;
  onChange: (id: string) => void;
  /** Nombre accesible del grupo (`aria-label` del tablist). */
  label: string;
  className?: string;
}

/**
 * Pestañas accesibles para dividir una página larga en secciones (configuración, detalle de un
 * préstamo) sin esconder el contenido detrás de una navegación que hay que recordar.
 *
 * Los paneles **no se desmontan** al cambiar de pestaña: se ocultan con `hidden`. Es a propósito —
 * el admin que está a mitad de una edición y mira otra sección vuelve a encontrarla como la dejó,
 * en vez de perder lo escrito. Montar solo el activo habría sido más simple y más barato, y habría
 * creado una pérdida de datos silenciosa.
 *
 * Teclado: ←/→ mueven el foco y activan (patrón WAI-ARIA de tablist); Inicio/Fin saltan a los
 * extremos. Los paneles son `tabIndex={0}` para que se pueda enfocar y leer con lector de pantalla.
 */
export function Tabs({ panels, value, onChange, label, className }: TabsProps) {
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activo = panels.some((panel) => panel.id === value) ? value : panels[0]?.id;
  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = panels.findIndex((panel) => panel.id === activo);
    if (index < 0) return;
    let destino = index;
    if (event.key === "ArrowRight") destino = (index + 1) % panels.length;
    else if (event.key === "ArrowLeft") destino = (index - 1 + panels.length) % panels.length;
    else if (event.key === "Home") destino = 0;
    else if (event.key === "End") destino = panels.length - 1;
    else return;

    event.preventDefault();
    const next = panels[destino];
    onChange(next.id);
    tabRefs.current[destino]?.focus();
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1"
      >
        {panels.map((panel, index) => {
          const seleccionado = panel.id === activo;
          return (
            <button
              key={panel.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={tabId(panel.id)}
              aria-selected={seleccionado}
              aria-controls={panelId(panel.id)}
              tabIndex={seleccionado ? 0 : -1}
              onClick={() => onChange(panel.id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                seleccionado
                  ? "bg-primary-50 text-primary-800"
                  : "text-ink-muted hover:bg-surface-muted hover:text-ink",
              )}
            >
              {panel.label}
              {typeof panel.badge === "number" && panel.badge > 0 ? (
                <span
                  data-slot="tab-badge"
                  className={cn(
                    "rounded-full px-1.5 text-xs font-semibold tabular-nums",
                    seleccionado ? "bg-primary-700 text-white" : "bg-surface-muted text-ink-muted",
                  )}
                >
                  {panel.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {panels.map((panel) => (
        <div
          key={panel.id}
          role="tabpanel"
          id={panelId(panel.id)}
          aria-labelledby={tabId(panel.id)}
          hidden={panel.id !== activo}
          tabIndex={0}
          className="focus:outline-none"
        >
          {panel.content}
        </div>
      ))}
    </div>
  );
}