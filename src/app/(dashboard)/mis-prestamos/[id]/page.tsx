import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { rethrowAsNotFound } from "@/lib/next-not-found";
import { summarizeLoan } from "@/services/credit/loan-service";
import { listPaymentsForLoan } from "@/services/payments/payment-list-service";
import { serializeListedPayment, toIso } from "@/lib/loan-json";
import { LoanDetail, type LoanDetailPayload } from "@/components/credit/loan-detail";
import { DelinquencyStatus } from "@/server/types";

export default async function MisPrestamosDetallePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // La sesión ya la validó el layout del grupo `(dashboard)`, pero aquí hace falta el `uid`: es lo
  // que ata el préstamo a su titular (`summarizeLoan` falla con 404 si el préstamo es de otro), y
  // no se puede inventar en el cliente.
  const { id } = await params;
  const cookieStore = await cookies();
  const db = getDb();

  let context;
  try {
    context = await requireUser({ auth: getAuthAdmin(), db, cookies: cookieStore });
  } catch {
    redirect("/login");
  }

  // El detalle y el historial se leen en el servidor: es la única forma de que `router.refresh()`
  // los actualice después de registrar un pago (un `useEffect` del cliente no se vuelve a correr).
  const data = await summarizeLoan(db, context.uid, id).catch(rethrowAsNotFound);

  // El historial va aparte a propósito: sin él se puede ver el calendario, y el error aparece en su
  // propia tarjeta en vez de tirar la pantalla entera.
  const { payments, paymentsError } = await listPaymentsForLoan({ db }, {
    loanId: id,
    userId: context.uid,
  }).then(
    (rows) => ({ payments: rows.map(serializeListedPayment), paymentsError: null }),
    (error: unknown) => ({
      payments: [],
      paymentsError: error instanceof Error ? error.message : "No se pudo cargar el historial de pagos",
    }),
  );

  // Se proyecta campo a campo en vez de `as`: es la frontera de serialización hacia el cliente, así
  // que lo que se manda son fechas ISO y los opcionales del doc ya resueltos, nunca `undefined` en
  // pantalla.
  const payload: LoanDetailPayload = {
    loan: {
      id: data.loan.id,
      loanNumber: data.loan.loanNumber,
      productCode: data.loan.productCode,
      status: data.loan.status,
      delinquencyStatus: data.loan.delinquencyStatus ?? DelinquencyStatus.CURRENT,
      daysPastDue: data.loan.daysPastDue ?? 0,
      principalPesos: data.loan.principalPesos,
      interestPesos: data.loan.interestPesos,
      feePesos: data.loan.feePesos,
      totalPayablePesos: data.loan.totalPayablePesos,
      outstandingPesos: data.loan.outstandingPesos ?? 0,
      createdAt: toIso(data.loan.createdAt),
    },
    installments: data.installments.map((cuota) => ({
      id: cuota.id,
      installmentNumber: cuota.installmentNumber,
      dueDate: toIso(cuota.dueDate),
      principalPesos: cuota.principalPesos,
      interestPesos: cuota.interestPesos,
      feePesos: cuota.feePesos,
      totalPesos: cuota.totalPesos,
      paidPesos: cuota.paidPesos,
      status: cuota.status,
      ...(cuota.paidAt ? { paidAt: toIso(cuota.paidAt) } : {}),
    })),
    nextDueAt: data.nextDueAt ? data.nextDueAt.toISOString() : null,
    nextInstallmentId: data.nextInstallmentId ?? null,
    installmentCount: data.installmentCount,
    paidInstallments: data.paidInstallments,
    outstandingPesos: data.outstandingPesos,
  };

  return (
    <div className="space-y-8">
      <div>
        <Link href="/mis-prestamos" className="text-sm text-primary-700 hover:underline">
          ← Volver a mis préstamos
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink">Detalle del préstamo</h1>
      </div>

      <LoanDetail data={payload} payments={payments} paymentsError={paymentsError} />
    </div>
  );
}
