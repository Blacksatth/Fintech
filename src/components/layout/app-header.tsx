import Link from "next/link";
import { SessionBar } from "@/components/auth/session-bar";
import { NavLinks, type NavItem } from "@/components/layout/nav-links";

export type { NavItem };

/**
 * Cabecera común de las pantallas con sesión (home, área del cliente y administración).
 *
 * Vive aparte de los layouts porque cada uno muestra enlaces distintos —un admin ve además su
 * sección— y duplicar la cabecera hacía que arreglar la navegación fuera cambiar tres archivos.
 * `nav` se deja vacío en la portada pública: ahí el único camino es entrar o registrarse.
 */
export function AppHeader({ nav = [], badge }: { nav?: NavItem[]; badge?: string }) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="mr-auto flex items-center gap-2">
          <span className="text-lg font-bold text-primary-700">Microcrédito</span>
          {badge ? (
            <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-700">
              {badge}
            </span>
          ) : null}
        </Link>

        {nav.length > 0 ? (
          // En móvil los enlaces bajan a su propia fila (`order-last` + `w-full`) en vez de
          // desbordar la barra; en escritorio se alinean a la derecha como antes. El estado
          // activo lo pinta NavLinks (Client Component para leer la ruta actual).
          <nav
            aria-label="Navegación principal"
            className="order-last flex w-full flex-wrap gap-x-4 gap-y-1 text-sm sm:order-none sm:w-auto sm:justify-end"
          >
            <NavLinks items={nav} />
          </nav>
        ) : null}

        <SessionBar />
      </div>
    </header>
  );
}
