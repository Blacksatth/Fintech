import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { approveLoanApplication } from "@/services/credit/approval-service";
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

    const { decisionNotes } = body;
    const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;

    const result = await approveLoanApplication(
      { db },
      { applicationId: id, actor: { uid: context.uid, role: context.role }, idempotencyKey: idempotencyKey ?? "", decisionNotes },
    );

    return Response.json({ application: result.application }, { status: 200 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}