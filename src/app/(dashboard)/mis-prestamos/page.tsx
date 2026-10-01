import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser, type AuthContext } from "@/auth/guards";
import { redirect } from "next/navigation";
import { LoansList } from "@/components/credit/loans-list";

export default async function MisPrestamosPage() {
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
        <h1 className="text-2xl font-bold tracking-tight text-ink">Mis préstamos</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Préstamos desembolsados a tu nombre, su saldo y su calendario de cuotas.
        </p>
      </div>

      <LoansList userId={context.uid} />
    </div>
  );
}
