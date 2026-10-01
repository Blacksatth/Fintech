import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { toErrorResponse } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/origin";
import { getLoanApplicationForUser, submitLoanApplicationService } from "@/services/credit/loan-application-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    const context = await requireUser({ auth, db, cookies: cookieStore });
    const { id } = await params;

    // 404 si no existe o si es de otro usuario: un 403 revelaría su existencia.
    const application = await getLoanApplicationForUser({ db }, context.uid, id);

    return Response.json({ application });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(request);

    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    const context = await requireUser({ auth, db, cookies: cookieStore });
    const { id } = await params;

    const body = await request.json();
    const action = body.action;

    if (action !== "submit") {
      return Response.json(
        { error: { code: "VALIDATION", message: "Acción no válida" } },
        { status: 400 },
      );
    }

    const submitted = await submitLoanApplicationService({ db }, id, context.uid);

    return Response.json({ application: submitted });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}