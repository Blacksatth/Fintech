import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { clearUserCreditLimit, setUserCreditLimit } from "@/services/users/user-limit-service";
import { toErrorResponse, badRequest } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/origin";
import { checkRateLimit, buildKey } from "@/lib/rate-limit";
import { z } from "zod";

/**
 * `POST /api/admin/users/:uid/limit` (PROJECT_SPEC §8, F13-2a).
 *
 * Ajusta el límite de crédito de un cliente (`user_limit_overrides/{uid}`) y deja auditoría
 * `LIMIT_CHANGED`. `creditLimitPesos: null` revoca el límite (marca `active: false`).
 *
 * No pide `Idempotency-Key` a propósito: el documento vive en `{uid}`, así que la operación es
 * idempotente por naturaleza (last-write-wins); la historia queda en `audit_logs`.
 */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 10 * 60 * 1000;

const setLimitBody = z.object({
  // Entero positivo **seguro**: pesos enteros COP (trampa de dinero del proyecto), nunca float.
  creditLimitPesos: z.union([
    z.number().refine((value) => Number.isSafeInteger(value) && value > 0, "debe ser un entero positivo seguro"),
    z.null(),
  ]),
  reason: z.string().trim().max(500).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ uid: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(request);

    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    const context = await requireAdmin({ auth, db, cookies: cookieStore });

    const limit = checkRateLimit(buildKey("user.limit", context.uid), RATE_LIMIT, RATE_WINDOW_MS);
    if (!limit.allowed) {
      return Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: `Demasiados ajustes de límite seguidos. Vuelve a intentarlo en ${Math.ceil(
              (limit.resetAt.getTime() - Date.now()) / 1000,
            )} s.`,
          },
        },
        { status: 429 },
      );
    }

    const { uid } = await params;
    if (uid.trim().length === 0) throw badRequest("Usuario vacío");

    // JSON inválido → `null` → `safeParse` falla → 400, no un 500 por `SyntaxError`.
    const body = setLimitBody.safeParse(await request.json().catch(() => null));
    if (!body.success) throw badRequest("Cuerpo inválido: creditLimitPesos entero positivo o null, y razón opcional");

    const now = new Date();
    const actor = { uid: context.uid, role: context.role };

    if (body.data.creditLimitPesos === null) {
      await clearUserCreditLimit(db, actor, { userId: uid, reason: body.data.reason }, now);
      return Response.json({ limit: { userId: uid, active: false } }, { status: 200 });
    }

    const doc = await setUserCreditLimit(
      db,
      actor,
      { userId: uid, creditLimitPesos: body.data.creditLimitPesos, reason: body.data.reason },
      now,
    );
    return Response.json(
      {
        limit: {
          userId: doc.userId,
          creditLimitPesos: doc.creditLimitPesos,
          reason: doc.reason,
          active: doc.active,
          createdAt: doc.createdAt,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}