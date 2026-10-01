import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { listUsersWithLimits } from "@/services/users/user-limit-service";
import { toErrorResponse } from "@/lib/errors";
import { toIso } from "@/lib/loan-json";
import { UserDoc } from "@/server/user-doc";
import { UserLimitOverrideDoc } from "@/server/credit-doc";

/**
 * `GET /api/admin/users` (PROJECT_SPEC §8, F13-2a).
 *
 * Lista los usuarios con su límite activo (`user_limit_overrides/{uid}`), para la pantalla de
 * administración de clientes. Lectura sola y barata: no necesita rate limit.
 */
export async function GET(): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    await requireAdmin({ auth, db, cookies: cookieStore });

    const rows = await listUsersWithLimits(db);

    return Response.json(
      {
        users: rows.map((row) => ({
          uid: row.uid,
          user: serializeUser(row.user),
          activeLimit: row.activeLimit ? serializeLimit(row.activeLimit) : null,
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}

function serializeUser(user: UserDoc) {
  return {
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role,
    status: user.status,
    createdAt: toIso(user.createdAt),
  };
}

function serializeLimit(limit: UserLimitOverrideDoc) {
  return {
    creditLimitPesos: limit.creditLimitPesos,
    overriddenBy: limit.overriddenBy,
    reason: limit.reason,
    active: limit.active,
    createdAt: toIso(limit.createdAt),
  };
}