"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Modal } from "@/components/ui";
import type { AdminPending } from "@/services/admin/admin-pending-service";

/**
 * Campana de pendientes del encabezado.
 *
 * Es la pieza que convierte el admin en "puesto de trabajo": en lugar de recorrer ocho secciones
 * para descubrir si hay algo que hacer, el número del encabezado dice cuánto y el diálogo dice qué.
 * Se queda en el encabezado a propósito —es el único punto que no se desplaza con el scroll de las
 * secciones—, mientras la navegación de secciones pasa al menú lateral.
 *
 * El contador se anuncia con `aria-live` para que un lector de pantalla lo escuche al cambiar tras
 * una confirmación, y el rótulo nunca es solo un número: dice "3 pendientes".
 */
export function AdminNotifications({ pending }: { pending: AdminPending }) {
  const [open, setOpen] = useState(false);
  const { items, total } = pending;
  const etiqueta = total === 0 ? "Sin pendientes" : `${total} pendiente${total === 1 ? "" : "s"}`;

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-label={`Notificaciones: ${etiqueta}`}
        className="relative gap-2"
      >
        <span aria-hidden className="text-base leading-none">
          🔔
        </span>
        <span className="hidden sm:inline">Notificaciones</span>
        <span
          aria-live="polite"
          data-slot="pending-badge"
          className={
            total > 0
              ? "rounded-full bg-danger px-1.5 text-xs font-semibold tabular-nums text-white"
              : "rounded-full bg-surface-muted px-1.5 text-xs font-medium text-ink-muted"
          }
        >
          {total > 0 ? total : "0"}
        </span>
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Notificaciones"
        description="Lo que espera una decisión tuya. Cada enlace abre la sección donde se resuelve."
        size="md"
      >
        {items.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No hay nada esperando decisión: sin solicitudes por revisar, pagos por confirmar ni
            préstamos por desembolsar.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border p-3 transition-colors hover:border-primary-600 hover:bg-surface-muted"
                >
                  <span>
                    <span className="block text-sm font-medium text-ink">{item.label}</span>
                    <span className="block text-xs text-ink-muted">{item.description}</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">
                    {item.count}
                    {item.truncated ? "+" : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}