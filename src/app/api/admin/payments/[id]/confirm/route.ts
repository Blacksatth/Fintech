import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { confirmPayment } from "@/services/payments/payment-service";
import { toErrorResponse } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/origin";

/**
 * `POST /api/admin/payments/:id/confirm` (PROJECT_SPEC §11, F10-2b).
 *
 * Confirmación **humana**: nadie más que un ADMIN mueve un pago de `PENDING` a `CONFIRMED`, y
 * cada confirmación es idempotente por `Idempotency-Key`.
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

    const result = await confirmPayment(
      { db },
      {
        paymentId: id,
        actor: { uid: context.uid, role: context.role },
        idempotencyKey,
        adminNote: typeof body.adminNote === "string" ? body.adminNote : undefined,
      },
    );

    return Response.json({ payment: result }, { status: 200 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}