"use client";

import { useState, type ReactNode } from "react";
import { Tabs } from "@/components/ui";
import { BatchReasonBar, BatchReasonProvider } from "./batch-reason";

export interface ConfigPanelInput {
  id: string;
  label: string;
  /** Contador opcional para la pestaña (p. ej. versions de tasa sin activar). */
  badge?: number;
  content: ReactNode;
}

/**
 * Configuración como pestañas, con el motivo escrito una vez (F13-2b).
 *
 * Antes eran cinco tarjetas apiladas en una sola columna, con el motivo repetido en cada formulario:
 * para llegar a los canales había que pasar por producto, tiers y tasas, y para hacer un solo ajuste
 * el admin escribía el mismo texto varias veces. Ahora son cinco pestañas y un motivo.
 *
 * Los paneles no se desmontan al cambiar de pestaña (`hidden` en `Tabs`), así que una edición a
 * medio hacer sobrevive al salto a otra sección.
 *
 * Este componente decide **qué se ve**; los datos siguen llegando del servidor y los formularios
 * siguen escribiendo por API con su motivo de tanda.
 */
export function ConfigWorkspace({ panels }: { panels: ConfigPanelInput[] }) {
  const [seccion, setSeccion] = useState(panels[0]?.id ?? "");

  return (
    <BatchReasonProvider>
      <div className="flex flex-col gap-4">
        <BatchReasonBar />
        <Tabs
          panels={panels}
          value={panels.some((panel) => panel.id === seccion) ? seccion : panels[0]?.id ?? ""}
          onChange={setSeccion}
          label="Secciones de configuración"
        />
      </div>
    </BatchReasonProvider>
  );
}