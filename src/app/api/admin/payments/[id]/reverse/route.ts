import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { reversePayment } from "@/services/payments/payment-service";
import { toErrorResponse } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/origin";

/**
 * `POST /api/admin/payments/:id/reverse` (PROJECT_SPEC §11, F10-2b).
 *
 * Deshace una confirmación (transferencia devuelta por el banco, pago acreditado por error) y
 * devuelve la cuota a `PENDING`. Exige `reason`: reversar dinero requiere explicar por qué.
 *
 * Aunque §9 no liste la ruta en su tabla, §11 define `CONFIRMED → REVERSED` como parte de la
 * máquina de estados y la acceptance de F10-2 pide reversar: la API pública la implementa igual.
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

    const result = await reversePayment(
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