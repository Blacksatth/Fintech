import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { loadNotificationsForUser } from "@/services/credit/client-dashboard-service";
import { NotificationsInbox } from "@/components/client/notifications";

export default async function MisNotificacionesPage() {
  const cookieStore = await cookies();
  const db = getDb();

  let context;
  try {
    context = await requireUser({ auth: getAuthAdmin(), db, cookies: cookieStore });
  } catch {
    redirect("/login");
  }

  // Bandeja SOLO lectura (F12). Marcar como leído, prioridades y reintentos son F15-1; aquí se
  // lee la colección `notifications` del propio usuario y se ordena del más reciente al más viejo.
  const notifications = await loadNotificationsForUser({ db }, context.uid);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Notificaciones</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Avisos de tus cuotas: próximas a vencer y vencidas.
        </p>
      </div>

      <NotificationsInbox notifications={notifications} />
    </div>
  );
}