import { cookies } from "next/headers";
import { z } from "zod";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { badRequest, tooManyRequests } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/origin";
import { buildKey, checkRateLimit } from "@/lib/rate-limit";

/**
 * Ceremonia común de las rutas de escritura de configuración (PROJECT_SPEC §9, F13-2b).
 *
 * Todas hacen lo mismo antes de tocar nada —Origin, sesión ADMIN, rate limit por admin, body
 * validado con zod— y el orden importa: Origin **antes** de leer la sesión (una mutación no debe
 * gastar ni revelar nada a un origen ajeno), y el rate limit **después** de autenticar para que la
 * ventana sea por admin y no por IP compartida de una oficina.
 *
 * Vive aquí y no duplicado en cada `route.ts` porque ocho rutas que repiten el mismo bloque
 * divergen en una de ellas sooner o later, y esa divergencia es un agujero.
 */

/**
 * Cambiar configuración es raro y deliberado, pero no gratis: una sesión robada o un bucle runaway
 * no debería poder reescribir la tasa de interés del producto en un minuto. 30 por hora por admin
 * es holgado para uso humano (una sesión completa de configuración no pasa de unas diez
 * operaciones) y corta el martilleo.
 */
export const CONFIG_WRITE_RATE_LIMIT = 30;
export const CONFIG_WRITE_WINDOW_MS = 60 * 60 * 1000;

export interface AdminConfigWriteRequest<T> {
  db: ReturnType<typeof getDb>;
  actor: { uid: string; role: string };
  body: T;
}

/**
 * Valida la petición y devuelve el body tipado. Lanza `AppError` (403 / 429 / 400) para que la ruta
 * lo traduzca con `toErrorResponse` como las demás, y devuelve la sesión ya resuelta para que la
 * ruta no vuelva a pedirla.
 */
export async function prepareAdminConfigWrite<T>(
  request: Request,
  schema: z.ZodType<T>,
  options: { rateScope: string },
): Promise<AdminConfigWriteRequest<T>> {
  assertSameOrigin(request);

  const cookieStore = await cookies();
  const db = getDb();
  const auth = getAuthAdmin();

  const context = await requireAdmin({ auth, db, cookies: cookieStore });

  const limit = checkRateLimit(
    buildKey("admin.config", options.rateScope, context.uid),
    CONFIG_WRITE_RATE_LIMIT,
    CONFIG_WRITE_WINDOW_MS,
  );
  if (!limit.allowed) {
    const seconds = Math.ceil((limit.resetAt.getTime() - Date.now()) / 1000);
    throw tooManyRequests(
      `Demasiados cambios de configuración seguidos. Vuelve a intentarlo en ${seconds} s.`,
    );
  }

  // JSON inválido → `null` → `safeParse` falla → 400, no un 500 por `SyntaxError`.
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw badRequest(`Cuerpo inválido — ${message}`);
  }

  return { db, actor: { uid: context.uid, role: context.role }, body: parsed.data };
}

/**
 * `Idempotency-Key` de las operaciones de configuración que **crean** (la versión de tasa).
 *
 * Los parches no la piden: viven en un doc de id determinista, así que repetirlos es
 * last-write-wins sobre el mismo documento y no duplica nada. Un alta, en cambio, reserva la
 * siguiente versión de tasa, y un doble clic produciría dos versiones — la segunda con el mismo
 * valor, porque el rate limit no impide el doble clic sino la ráfaga.
 */
export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    throw badRequest("Falta el header Idempotency-Key: esta operación crea configuración.");
  }
  if (key.length > 200) {
    throw badRequest("El Idempotency-Key es demasiado largo (máximo 200 caracteres).");
  }
  return key;
}
