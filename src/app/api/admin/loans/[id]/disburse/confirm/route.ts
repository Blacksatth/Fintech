import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { confirmLoanDisbursement } from "@/services/credit/disbursement-service";
import { toErrorResponse } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/origin";

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

    const result = await confirmLoanDisbursement(
      { db },
      {
        loanId: id,
        actor: { uid: context.uid, role: context.role },
        idempotencyKey,
        reference: typeof body.reference === "string" ? body.reference : undefined,
      },
    );

    return Response.json({ disbursement: result }, { status: 200 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
