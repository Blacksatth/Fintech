import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { getCreditScore } from "@/services/credit/scoring-service";
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

    await requireAdmin({ auth, db, cookies: cookieStore });

    const appSnap = await db.collection("loan_applications").doc(id).get();
    if (!appSnap.exists) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Solicitud no encontrada" } },
        { status: 404 },
      );
    }

    const app = appSnap.data();
    if (!app?.userId) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Solicitud sin usuario" } },
        { status: 404 },
      );
    }
    const score = await getCreditScore({ db }, app.userId, id);

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