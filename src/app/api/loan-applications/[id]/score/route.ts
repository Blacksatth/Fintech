import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { getCreditScore } from "@/services/credit/scoring-service";
import { getLoanApplicationForUser } from "@/services/credit/loan-application-service";
import { toErrorResponse } from "@/lib/errors";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();
    const { id } = await params;

    const context = await requireUser({ auth, db, cookies: cookieStore });

    // 404 si no existe o si es de otro usuario: no se revela la existencia de la ajena.
    await getLoanApplicationForUser({ db }, context.uid, id);

    const score = await getCreditScore({ db }, context.uid, id);

    if (!score) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Score no encontrado" } },
        { status: 404 },
      );
    }

    return Response.json({ score });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}