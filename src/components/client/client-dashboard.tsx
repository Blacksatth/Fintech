import type { ClientDashboardSnapshot } from "@/server/client-dashboard";
import { ActiveLoanCard } from "@/components/client/active-loan-card";
import { QuickAccess } from "@/components/client/quick-access";
import { NotificationsPreview } from "@/components/client/notifications";

export interface ClientDashboardProps {
  /** Nombre a mostrar en el saludo: fullName si existe, si no el email. */
  userName: string;
  snapshot: ClientDashboardSnapshot;
}

/**
 * Inicio del cliente (F12): estado financiero + accesos rápidos + últimos avisos.
 *
 * Todo llega del servidor (`page.tsx`), en servicio SOLO lectura: abrir el inicio no escribe en
 * Firestore. La única dependencia de cliente vive en la cabecera (estado activo del nav), no aquí.
 */
export function ClientDashboard({ userName, snapshot }: ClientDashboardProps) {
  return (
    <div className="space-y-8">
      <section className="flex flex-col items-start gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-ink">Hola, {userName}</h1>
        </div>
        <p className="text-sm text-ink-muted">
          Así está tu crédito hoy. Los pagos que registres quedan en revisión hasta que el
          administrador los confirme.
        </p>
      </section>

      <ActiveLoanCard snapshot={snapshot} />

      <QuickAccess
        activeLoanId={snapshot.activeLoan?.id ?? null}
        canRegisterPayment={snapshot.canRegisterPayment}
      />

      <NotificationsPreview notifications={snapshot.notifications} />
    </div>
  );
}