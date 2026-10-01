import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { AppError } from "@/lib/errors";
import { SessionBar } from "@/components/auth/session-bar";
import { AdminNav } from "@/components/admin/admin-nav";
import { AdminNotifications } from "@/components/admin/admin-notifications";
import { getAdminPending } from "@/services/admin/admin-pending-service";
import type { NavItem } from "@/components/layout/nav-links";

const NAV_ADMIN: NavItem[] = [
  { href: "/", label: "Inicio" },
  { href: "/admin", label: "Panel" },
  { href: "/admin/loan-applications", label: "Solicitudes" },
  { href: "/admin/prestamos", label: "Préstamos" },
  { href: "/admin/pagos", label: "Pagos" },
  { href: "/admin/mora", label: "Mora" },
  { href: "/admin/usuarios", label: "Usuarios" },
  { href: "/admin/configuracion", label: "Configuración" },
  { href: "/mis-solicitudes", label: "Mis solicitudes" },
];

/**
 * Shell de la administración: encabezado (identidad, notificaciones, sesión) + menú lateral de
 * secciones + contenido.
 *
 * El encabezado no lleva enlaces de sección: son ocho y competían por el ancho con el logotipo, la
 * campana y el botón de salida. Las secciones viven en el rail de la izquierda, agrupadas en
 * "Administración" y "Área del cliente" para que quedar dentro del admin y salir de él no sean el
 * mismo gesto.
 *
 * Las notificaciones **sí** se quedan en el encabezado: son el único dato que tiene que ser
 * visible desde cualquier sección y sin desplazarse, así que el rail se las pasa al servidor una vez
 * por render y el contador queda a mano en todas las páginas.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const db = getDb();
  const auth = getAuthAdmin();

  let authError: unknown;
  try {
    await requireAdmin({ auth, db, cookies: cookieStore });
  } catch (error) {
    authError = error;
  }

  if (authError) {
    // 403 = sesión válida pero no es ADMIN (mandarlo a /login sería un bucle confuso);
    // cualquier otro fallo es sesión inválida.
    const isForbidden = authError instanceof AppError && authError.statusCode === 403;
    redirect(isForbidden ? "/solicitar" : "/login");
  }

  // Un contador de pendientes que no se puede leer no debe tumbar el admin entero: si la consulta
  // falla, la campana se queda en cero y el resto del panel sigue funcionando.
  const pending = await getAdminPending({ db }).catch(() => ({ items: [], total: 0 }));

  return (
    <div className="flex min-h-screen flex-col bg-surface-muted">
      <header className="sticky top-0 z-10 border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link href="/" className="mr-auto flex items-center gap-2">
            <span className="text-lg font-bold text-primary-700">Microcrédito</span>
            <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-700">
              Administración
            </span>
          </Link>
          <AdminNotifications pending={pending} />
          <SessionBar />
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col lg:flex-row">
        <AdminNav
          items={NAV_ADMIN}
          pending={Object.fromEntries(
            pending.items.map((item) => [item.href, item.count]),
          )}
        />
        <main className="min-w-0 flex-1 px-4 py-8">{children}</main>
      </div>
    </div>
  );
}