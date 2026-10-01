import { AccessTile } from "@/components/client/access-tile";

export interface QuickAccessProps {
  /** Préstamo activo: para enlazar "Registrar pago" e "Historial" al detalle correcto. */
  activeLoanId: string | null;
  canRegisterPayment: boolean;
}

interface Acceso {
  href: string;
  title: string;
  description: string;
  cta: string;
  /** `false` oculta la tarjeta; evita mostar un camino que devolvería un detalle sin pagar nada. */
  visible?: boolean;
}

/**
 * Accesos rápidos del dashboard. Los rutas cliente ya existen; aquí se evitan los callejones
 * sin salida: "Registrar pago" solo aparece con un préstamo desembolsado y "Historial de pagos"
 * apunta al detalle del préstamo activo (donde vive el historial), no a una pantalla vacía.
 */
export function QuickAccess({ activeLoanId, canRegisterPayment }: QuickAccessProps) {
  const activos: Acceso[] = [
    {
      href: "/solicitar",
      title: "Solicitar préstamo",
      description: "Pide un microcrédito en pesos; se puntúa al instante y el administrador lo revisa.",
      cta: "Nueva solicitud",
    },
    {
      href: "/mis-prestamos",
      title: "Mis préstamos",
      description: "Saldo, calendario de cuotas y comprobantes de cada préstamo.",
      cta: "Ver préstamos",
    },
    {
      href: "/mis-solicitudes",
      title: "Mis solicitudes",
      description: "Estado y puntaje de cada solicitud, con el motivo si la rechazan.",
      cta: "Ver solicitudes",
    },
    {
      href: activeLoanId ? `/mis-prestamos/${activeLoanId}` : "/mis-prestamos",
      title: "Historial de pagos",
      description: "Los pagos que has registrado y cómo van quedando al día tus cuotas.",
      cta: "Ver historial",
    },
    {
      href: "/mis-notificaciones",
      title: "Notificaciones",
      description: "Avisos de cuotas próximas a vencer y de cuotas vencidas.",
      cta: "Ver avisos",
    },
    {
      href: activeLoanId ? `/mis-prestamos/${activeLoanId}` : "/solicitar",
      title: "Registrar pago",
      description: "Marca el pago de una cuota; queda en revisión hasta que el administrador lo confirme.",
      cta: "Registrar pago",
      visible: canRegisterPayment,
    },
  ];

  return (
    <section aria-labelledby="titulo-accesos" className="flex flex-col gap-4">
      <h2 id="titulo-accesos" className="text-lg font-semibold text-ink">
        Accesos rápidos
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {activos
          .filter((acceso) => acceso.visible !== false)
          .map((acceso) => (
            <AccessTile key={acceso.title} {...acceso} />
          ))}
      </div>
    </section>
  );
}