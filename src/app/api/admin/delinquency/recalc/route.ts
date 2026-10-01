import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { recalcActivePortfolio, recalcLoanDelinquencyNow } from "@/services/credit/delinquency-service";
import { toErrorResponse } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/origin";
import { checkRateLimit, buildKey } from "@/lib/rate-limit";

/**
 * `POST /api/admin/delinquency/recalc` (PROJECT_SPEC §13, F11).
 *
 * Recalcula la caché de mora **bajo demanda**: el botón "Recalcular cartera" de `/admin/mora`.
 * Sin cuerpo recalcula toda la cartera activa; con `{ loanId }` solo ese préstamo.
 *
 * No pide `Idempotency-Key` a propósito: la operación es idempotente por naturaleza (escribe los
 * mismos valores y solo toca lo que cambia), así que un doble clic no daña nada. Lo que sí lleva
 * es rate limit, porque cada pasada lee cuotas y titulares de hasta `DELINQUENCY_SCAN_LIMIT`
 * préstamos: hammering el botón sería una forma barata de gastar lecturas.
 */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 10 * 60 * 1000;

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);

    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    const context = await requireAdmin({ auth, db, cookies: cookieStore });

    const limit = checkRateLimit(
      buildKey("delinquency.recalc", context.uid),
      RATE_LIMIT,
      RATE_WINDOW_MS,
    );
    if (!limit.allowed) {
      return Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: `Demasiados recálculos seguidos. Vuelve a intentarlo en ${Math.ceil(
              (limit.resetAt.getTime() - Date.now()) / 1000,
            )} s.`,
          },
        },
        { status: 429 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { loanId?: unknown };
    const loanId = typeof body.loanId === "string" && body.loanId.trim() !== "" ? body.loanId.trim() : null;

    if (loanId !== null) {
      const { row, changed } = await recalcLoanDelinquencyNow({ db }, loanId);
      return Response.json({ loan: { id: row.loanId, changed } }, { status: 200 });
    }

    const summary = await recalcActivePortfolio(
      { db },
      { uid: context.uid, role: context.role },
    );
    return Response.json({ summary }, { status: 200 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
