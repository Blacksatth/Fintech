import type { DashboardNotificationView } from "@/server/client-dashboard";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/link-button";
import { formatDateTime, notificationTypeLabel } from "@/lib/credit-labels";

const PREVIEW_LIMIT = 3;

function NotificationItem({ aviso }: { aviso: DashboardNotificationView }) {
  return (
    <li>
      <div className="flex flex-col gap-1 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{notificationTypeLabel(aviso.type)}</Badge>
          <time dateTime={aviso.sentAtIso ?? undefined} className="text-xs text-ink-subtle">
            {aviso.sentAtIso ? formatDateTime(aviso.sentAtIso) : "—"}
          </time>
        </div>
        <p className="text-sm font-medium text-ink">{aviso.title}</p>
        <p className="text-sm text-ink-muted">{aviso.body}</p>
      </div>
    </li>
  );
}

/**
 * Avisos del dashboard: los últimos N, SOLO lectura. Marcar como leído, priorizar y reintentar
 * envíos es F15-1.
 */
export function NotificationsPreview({ notifications }: { notifications: DashboardNotificationView[] }) {
  const visibles = notifications.slice(0, PREVIEW_LIMIT);

  return (
    <section aria-labelledby="titulo-avisos" className="flex flex-col gap-4">
      <h2 id="titulo-avisos" className="text-lg font-semibold text-ink">
        Últimos avisos
      </h2>

      {visibles.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-ink-muted">
              No tienes avisos todavía. Cuando una cuota esté próxima a vencer o vencida, te
              avisaremos aquí.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">{visibles.map((aviso) => <NotificationItem key={aviso.id} aviso={aviso} />)}</ul>
          <CardFooter className="justify-end">
            <LinkButton href="/mis-notificaciones" variant="ghost" size="sm">
              Ver todas
            </LinkButton>
          </CardFooter>
        </Card>
      )}
    </section>
  );
}

/**
 * Bandeja completa de `/mis-notificaciones`: la lista entera, sin recorte ni enlace a sí misma.
 * Vacía con el mismo copy que la previsualización, con su acción.
 */
export function NotificationsInbox({ notifications }: { notifications: DashboardNotificationView[] }) {
  return (
    <section aria-labelledby="titulo-bandeja" className="flex flex-col gap-4">
      <h2 id="titulo-bandeja" className="text-lg font-semibold text-ink">
        Bandeja
      </h2>

      {notifications.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-ink-muted">
              Aún no hay avisos, asi que estás al día. Cuando una cuota esté próxima o vencida,
              aparecerá aquí.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {notifications.map((aviso) => <NotificationItem key={aviso.id} aviso={aviso} />)}
          </ul>
        </Card>
      )}
    </section>
  );
}