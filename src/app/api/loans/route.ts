import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { toErrorResponse } from "@/lib/errors";
import { listLoansForUser } from "@/services/credit/loan-service";
import { serializeLoan } from "@/lib/loan-json";

/** Lista los préstamos del cliente autenticado. */
export async function GET(): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    const context = await requireUser({ auth, db, cookies: cookieStore });

    const loans = await listLoansForUser(db, context.uid);

    return Response.json({ loans: loans.map(serializeLoan) });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
