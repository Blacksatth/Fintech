import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { toErrorResponse } from "@/lib/errors";
import { quoteLoanPlan } from "@/services/credit/credit-product-quote-service";

export async function GET(request: Request): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    await requireUser({ auth, db, cookies: cookieStore });

    const { searchParams } = new URL(request.url);
    const productId = searchParams.get("productId") ?? "";
    const amountPesos = Number(searchParams.get("amountPesos"));
    const termInstallments = Number(searchParams.get("termInstallments"));

    if (
      !productId ||
      !Number.isSafeInteger(amountPesos) ||
      amountPesos <= 0 ||
      !Number.isSafeInteger(termInstallments)
    ) {
      return Response.json(
        { error: { code: "VALIDATION", message: "Parámetros inválidos" } },
        { status: 400 },
      );
    }

    const quote = await quoteLoanPlan(db, { productId, amountPesos, termInstallments }, new Date());

    return Response.json({ quote });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}