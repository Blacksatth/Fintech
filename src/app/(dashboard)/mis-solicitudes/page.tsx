import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser, type AuthContext } from "@/auth/guards";
import { redirect } from "next/navigation";
import { LoanApplicationsList } from "@/components/credit/loan-applications-list";

export default async function MisSolicitudesPage() {
  const cookieStore = await cookies();
  const db = getDb();
  const auth = getAuthAdmin();

  let context: AuthContext;
  try {
    context = await requireUser({ auth, db, cookies: cookieStore });
  } catch {
    redirect("/login");
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Mis solicitudes</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Historial de tus solicitudes de crédito y su estado actual.
        </p>
      </div>

      <LoanApplicationsList userId={context.uid} />
    </div>
  );
}