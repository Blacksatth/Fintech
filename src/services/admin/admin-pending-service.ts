import { type Firestore } from "firebase-admin/firestore";
import { ApplicationStatus, LoanStatus, PaymentStatus } from "@/server/types";

export interface AdminPendingItem {
  id: string;
  label: string;
  /** Enlace a la sección donde se resuelve. */
  href: string;
  /** Textura para el admin: qué tiene que hacer, no solo cuántos son. */
  description: string;
  count: number;
  /** `true` cuando `count` es un piso: la consulta tiene tope de lectura. */
  truncated?: boolean;
}

export interface AdminPending {
  items: AdminPendingItem[];
  /** Total de lo que requiere una acción humana ahora mismo. */
  total: number;
}

export interface AdminPendingDeps {
  db: Firestore;
}

/** Tope por consulta: la campana es una señal de trabajo, no un inventario exacto. */
export const PENDING_SCAN_LIMIT = 200;

/**
 * Qué está esperando una decisión del admin, para la campana del encabezado y la cola del panel.
 *
 * Tres consultas de igualdad sobre un solo campo (índice automático siempre disponible) —no
 * `where` con dos condiciones— porque el panel tiene que abrir rápido y una consulta sin índice
 * compuesto es justo lo que rompe la página completa cuando falta desplegarlo.
 *
 * Los conteos son deliberadamente "piso": si una cola supera el tope, `truncated` lo dice y la
 * campana muestra `200+`. Es preferible a fingir un total exacto que nobody verificó.
 */
export async function getAdminPending({
  db,
}: AdminPendingDeps): Promise<AdminPending> {
  const [solicitudes, pagos, desembolsos] = await Promise.all([
    countBy(db, "loan_applications", [ApplicationStatus.SUBMITTED, ApplicationStatus.UNDER_REVIEW]),
    countBy(db, "payments", [PaymentStatus.PENDING]),
    countBy(db, "loans", [LoanStatus.PENDING_DISBURSEMENT]),
  ]);

  const items: AdminPendingItem[] = [
    {
      id: "solicitudes",
      label: "Solicitudes por revisar",
      href: "/admin/loan-applications",
      description: "Aprueba o rechaza las solicitudes que esperan tu decisión.",
      ...solicitudes,
    },
    {
      id: "pagos",
      label: "Pagos por confirmar",
      href: "/admin/pagos",
      description: "Confirma o rechaza los pagos registrados por los clientes.",
      ...pagos,
    },
    {
      id: "desembolsos",
      label: "Préstamos por desembolsar",
      href: "/admin/prestamos",
      description: "Confirma el desembolso de los créditos ya aprobados.",
      ...desembolsos,
    },
  ];

  const visibles = items.filter((item) => item.count > 0);

  return {
    items: visibles,
    total: visibles.reduce((suma, item) => suma + item.count, 0),
  };
}

async function countBy(
  db: Firestore,
  collection: string,
  statuses: string[],
): Promise<{ count: number; truncated: boolean }> {
  const conteos = await Promise.all(
    statuses.map((status) =>
      db.collection(collection).where("status", "==", status).limit(PENDING_SCAN_LIMIT).get(),
    ),
  );
  const count = conteos.reduce((suma, snap) => suma + snap.size, 0);
  return { count, truncated: conteos.some((snap) => snap.size >= PENDING_SCAN_LIMIT) };
}