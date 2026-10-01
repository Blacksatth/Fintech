"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { NavItem } from "@/components/layout/nav-links";

/**
 * Navegación del admin como menú lateral fijo.
 *
 * Antes iban ocho enlaces en el encabezado, que es la barra más estrecha y más disputada de la
 * pantalla: con las secciones del admin más las del cliente, el menú se comía el ancho completo y
 * no distinguía "secciones del admin" de "salir al área del cliente". Ahora el rail agrupa por
 * secciones y el encabezado queda para identidad, notificaciones y sesión.
 *
 * Responsive sin JavaScript de por medio: en escritorio (`lg:`) es una columna pegada al borde; en
 * móvil la misma lista se convierte en una fila desplazable horizontal. Un botón de hamburguesa que
 * dependa de un `useState` para abrir el menú es justo el tipo de cosa que se queda cerrada —o
 * abierta para siempre— en móvil, y aquí no hace falta.
 *
 * El enlace activo se marca con `aria-current="page"` y color primario, no solo con la posición en
 * la lista.
 */
export function AdminNav({ items, pending }: { items: NavItem[]; pending: Record<string, number> }) {
  const pathname = usePathname() ?? "/admin";

  const admin = items.filter((item) => item.href.startsWith("/admin"));
  const cliente = items.filter((item) => !item.href.startsWith("/admin"));

  const links = (list: NavItem[]) =>
    list.map((item) => {
      const activo =
        item.href === "/admin"
          ? pathname === "/admin"
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
      const badge = pending[item.href];

      return (
        <Link
          key={item.href}
          href={item.href}
          aria-current={activo ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
            activo
              ? "bg-primary-50 text-primary-800"
              : "text-ink-muted hover:bg-surface-muted hover:text-ink",
          )}
        >
          <span>{item.label}</span>
          {typeof badge === "number" && badge > 0 ? (
            <span
              data-slot="nav-badge"
              className="rounded-full bg-danger px-1.5 text-xs font-semibold tabular-nums text-white"
            >
              {badge}
            </span>
          ) : null}
        </Link>
      );
    });

  return (
    <nav
      aria-label="Secciones de administración"
      className="flex w-full gap-1 overflow-x-auto border-b border-border px-2 py-2 lg:w-64 lg:shrink-0 lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r lg:px-3 lg:py-4"
    >
      <p className="hidden px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle lg:block">
        Administración
      </p>
      <div className="flex gap-1 lg:flex-col lg:gap-0.5">{links(admin)}</div>

      <p className="hidden px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-ink-subtle lg:block">
        Área del cliente
      </p>
      <div className="flex gap-1 lg:flex-col lg:gap-0.5">{links(cliente)}</div>
    </nav>
  );
}