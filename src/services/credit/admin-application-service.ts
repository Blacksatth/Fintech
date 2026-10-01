import { type Firestore } from "firebase-admin/firestore";
import { type ApplicationStatus } from "@/server/types";
import { type CreditScoreDoc, type LoanApplicationDoc } from "@/server/credit-doc";
import { type UserDoc, type UserProfileDoc } from "@/server/user-doc";
import { getCreditScore } from "./scoring-service";

export interface AdminApplicationDeps {
  db: Firestore;
}

export interface AdminApplicationItem extends LoanApplicationDoc {
  id: string;
}

export interface ApplicantSummary {
  user: UserDoc | null;
  profile: UserProfileDoc | null;
}

export interface ApplicationReview {
  application: AdminApplicationItem;
  applicant: ApplicantSummary;
  score: CreditScoreDoc | null;
}

/** Tope de la lista admin: la vista es operativa, no un export. */
export const ADMIN_LIST_LIMIT = 50;

export interface AdminListFilter {
  status?: ApplicationStatus;
}

/**
 * Listado para revisión admin. Sin filtro usa el índice simple de `createdAt`.
 *
 * Con filtro la query es de **igualdad de un solo campo** (índice automático, siempre
 * disponible) y el orden se resuelve en memoria. La alternativa `where(status) +
 * orderBy(createdAt)` necesita el compuesto `[status, createdAt desc]`: está declarado en
 * `firestore.indexes.json`, pero desplegarlo exige `roles/datastore.owner` y el service
 * account no lo tiene, así que en el proyecto real esas pantallas daban 500
 * (`FAILED_PRECONDITION: The query requires an index`). Declarado no es desplegado.
 */
export async function listApplicationsForAdmin(
  deps: AdminApplicationDeps,
  filter: AdminListFilter = {},
): Promise<AdminApplicationItem[]> {
  const base = deps.db.collection("loan_applications");
  const snap = filter.status
    ? await base.where("status", "==", filter.status).limit(ADMIN_LIST_LIMIT).get()
    : await base.orderBy("createdAt", "desc").limit(ADMIN_LIST_LIMIT).get();

  return snap.docs
    .map((doc) => ({ ...(doc.data() as LoanApplicationDoc), id: doc.id }))
    .sort((a, b) => {
      // `createdAt` es `CreditDocDate` (Date | Timestamp): se normaliza antes de comparar.
      const diff = toMillis(b.createdAt) - toMillis(a.createdAt);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value !== null && "toMillis" in value) {
    return (value as { toMillis(): number }).toMillis();
  }
  if (typeof value === "number") return value;
  return 0;
}

/**
 * Todo lo que el admin necesita para decidir en una vista: solicitud, solicitante
 * y score. El score viene de `credit_scores/{applicationId}` (misma clave que usa
 * el servicio de scoring), y puede ser `null`: aprobar sin score es un 409 y la UI
 * debe decirlo antes de que el admin intente.
 */
export async function getApplicationForReview(
  deps: AdminApplicationDeps,
  applicationId: string,
): Promise<ApplicationReview | null> {
  const snap = await deps.db.collection("loan_applications").doc(applicationId).get();
  if (!snap.exists) return null;

  const application: AdminApplicationItem = {
    ...(snap.data() as LoanApplicationDoc),
    id: snap.id,
  };

  const [userSnap, profileSnap, score] = await Promise.all([
    deps.db.collection("users").doc(application.userId).get(),
    deps.db.collection("user_profiles").doc(application.userId).get(),
    getCreditScore(deps, application.userId, applicationId),
  ]);

  return {
    application,
    applicant: {
      user: userSnap.exists ? (userSnap.data() as UserDoc) : null,
      profile: profileSnap.exists ? (profileSnap.data() as UserProfileDoc) : null,
    },
    score,
  };
}
