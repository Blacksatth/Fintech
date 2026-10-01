import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { toErrorResponse } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/origin";
import { createLoanApplication, listLoanApplications } from "@/services/credit/loan-application-service";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);

    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    const context = await requireUser({ auth, db, cookies: cookieStore });

    const body = await request.json();

    const { productId, requestedAmountPesos, termInstallments, termFrequency } = body;

    if (!productId || !requestedAmountPesos || !termInstallments || !termFrequency) {
      return Response.json(
        { error: { code: "VALIDATION", message: "Faltan campos requeridos" } },
        { status: 400 },
      );
    }

    const result = await createLoanApplication(
      { db },
      {
        userId: context.uid,
        productId,
        requestedAmountPesos,
        termInstallments,
        termFrequency,
      },
    );

    return Response.json(
      {
        application: result.application,
        eligibleTier: result.eligibleTier,
      },
      { status: 201 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}

export async function GET(): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    const context = await requireUser({ auth, db, cookies: cookieStore });

    const applications = await listLoanApplications({ db }, context.uid);

    return Response.json({ applications });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}