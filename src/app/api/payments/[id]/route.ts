import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { toErrorResponse } from "@/lib/errors";
import { Role } from "@/server/types";
import { getPaymentForAdmin, getPaymentForUser } from "@/services/payments/payment-service";

/**
 * Detalle de un pago (§9: `owner/ADMIN`).
 *
 * El ADMIN llega hasta aquí porque su permiso viene del rol, no de ser el dueño. Para un
 * CUSTOMER, un pago ajeno responde 404 —igual que uno inexistente— para no revelar que existe
 * (`assertOwnedBy`).
 */
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

    const payment =
      context.role === Role.ADMIN
        ? await getPaymentForAdmin({ db }, { paymentId: id })
        : await getPaymentForUser({ db }, { paymentId: id, userId: context.uid });

    return Response.json({ payment });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
