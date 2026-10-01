import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { rejectPayment } from "@/services/payments/payment-service";
import { toErrorResponse } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/origin";

/**
 * `POST /api/admin/payments/:id/reject` (PROJECT_SPEC §11, F10-2b).
 *
 * El rechazo exige un `reason`: es lo que hace auditable que un pago que el cliente afirma haber
 * hecho no se acreditó (referencia incorrecta, monto distinto, transferencia devuelta...). Libera
 * el candado de la cuota para que el cliente pueda volver a pagar.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(request);

    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    const context = await requireAdmin({ auth, db, cookies: cookieStore });

    const { id } = await params;
    const body = await request.json();
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";

    const result = await rejectPayment(
      { db },
      {
        paymentId: id,
        actor: { uid: context.uid, role: context.role },
        idempotencyKey,
        reason: body.reason,
      },
    );

    return Response.json({ payment: result }, { status: 200 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}