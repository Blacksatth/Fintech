import { type Firestore } from "firebase-admin/firestore";
import { ApplicationStatus } from "@/server/types";
import { applicationStatusLabel } from "@/lib/credit-labels";

export interface ApplicationFunnel {
  byStatus: { status: ApplicationStatus; label: string; count: number }[];
  total: number;
  /** Suma de todos los estados leídos. `true` si alguna consulta tocó su tope. */
  truncated: boolean;
}

export interface ApplicationFunnelDeps {
  db: Firestore;
}

/** Tope por consulta, igual que en el resto de las agregaciones del admin. */
export const FUNNEL_SCAN_LIMIT = 1000;

const STATUSES = Object.values(ApplicationStatus) as ApplicationStatus[];

/**
 * Embudo de solicitudes por estado, para que el panel diga **qué hay que hacer** y no solo
 * cuánto dinero hay en la cartera.
 *
 * El panel ya agregaba la cartera desde `loans`, pero el trabajo del día a día de un admin ocurre
 * **antes** del préstamo: revisar solicitudes. Con la cartera vacía el panel mostraba todo en cero y
 * no decía nada, que se lee como "no hay nada que hacer" cuando en realidad había cientos de
 * solicitudes esperando. Esta lectura es la que llena ese hueco.
 *
 * Una consulta de igualdad por estado (índice automático) y orden en memoria: sin índices compuestos
 * y sin `orderBy`, que es lo que se puede garantizar en el proyecto real.
 */
export async function getApplicationFunnel({ db }: ApplicationFunnelDeps): Promise<ApplicationFunnel> {
  const snaps = await Promise.all(
    STATUSES.map((status) =>
      db.collection("loan_applications").where("status", "==", status).limit(FUNNEL_SCAN_LIMIT).get(),
    ),
  );
  const truncated = snaps.some((snap) => snap.size >= FUNNEL_SCAN_LIMIT);

  const byStatus = STATUSES.map((status, index) => ({
    status,
    label: applicationStatusLabel(status),
    count: snaps[index].size,
  })).filter((row) => row.count > 0);

  return {
    byStatus,
    total: byStatus.reduce((suma, row) => suma + row.count, 0),
    truncated,
  };
}