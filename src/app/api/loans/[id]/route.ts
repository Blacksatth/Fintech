import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { toErrorResponse } from "@/lib/errors";
import { summarizeLoan } from "@/services/credit/loan-service";
import { serializeInstallment, serializeLoan } from "@/lib/loan-json";

/** Detalle de un préstamo: calendario de cuotas y próximo vencimiento. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    const context = await requireUser({ auth, db, cookies: cookieStore });
    const { id } = await params;

    const summary = await summarizeLoan(db, context.uid, id);

    return Response.json({
      loan: serializeLoan(summary.loan),
      installments: summary.installments.map(serializeInstallment),
      nextDueAt: summary.nextDueAt ? summary.nextDueAt.toISOString() : null,
      nextInstallmentId: summary.nextInstallmentId ?? null,
      installmentCount: summary.installmentCount,
      paidInstallments: summary.paidInstallments,
      outstandingPesos: summary.outstandingPesos,
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
