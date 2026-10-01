import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser, type AuthContext } from "@/auth/guards";
import { redirect } from "next/navigation";
import { LoanApplicationForm } from "@/components/credit/loan-application-form";

export default async function SolicitarPage() {
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
        <h1 className="text-2xl font-bold tracking-tight text-ink">Solicitar préstamo</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Elige el monto según tu historial y capacidad de pago. El monto se asigna automáticamente
          según tu tier elegible.
        </p>
      </div>

      <LoanApplicationForm userId={context.uid} />
    </div>
  );
}