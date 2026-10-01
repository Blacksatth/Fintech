import type { Auth } from "firebase-admin/auth";
import { badRequest, toErrorResponse, unauthorized } from "../../lib/errors";
import { assertSameOrigin } from "../../lib/origin";
import { buildKey, checkRateLimit } from "../../lib/rate-limit";
import { sessionExchangeSchema } from "../../server/auth-input";
import {
  SESSION_COOKIE_NAME,
  createSessionCookieForIdToken,
  revokeAllSessions,
  sessionCookieOptions,
  verifyIdTokenIdentity,
  verifySessionCookieForRequest,
} from "../../server/auth-session";
import type { EnsureAppUserInput, EnsureAppUserResult } from "../users/ensure-app-user";

export type SessionCookieOptions = ReturnType<typeof sessionCookieOptions>;

export interface CookieStoreLike {
  get(name: string): { name: string; value: string } | undefined;
  set(name: string, value: string, options: SessionCookieOptions): unknown;
  delete(name: string): unknown;
}

export interface SessionEndpointDeps {
  auth: Auth;
  cookies: CookieStoreLike;
  isProduction?: boolean;
  rateLimit?: { limit: number; windowMs: number };
}

export type EnsureAppUser = (input: EnsureAppUserInput) => Promise<EnsureAppUserResult>;

/**
 * El exchange sí exige `ensureAppUser` (es el paso que crea `users/{uid}` al
 * registrarse): hacerlo opcional permitiría olvidarlo en el cableado y dejar
 * sesiones activas sin usuario de aplicación.
 */
export interface ExchangeSessionDeps extends SessionEndpointDeps {
  ensureAppUser: EnsureAppUser;
}

export interface EndpointResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const DEFAULT_RATE_LIMIT = { limit: 20, windowMs: 5 * 60 * 1000 };

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first ? first : "desconocida";
}

function rateLimitGuard(
  request: Request,
  scope: string,
  config: { limit: number; windowMs: number },
): EndpointResult | null {
  const result = checkRateLimit(buildKey(`auth:${scope}`, clientIp(request)), config.limit, config.windowMs);
  if (result.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
  return {
    status: 429,
    body: { error: { code: "RATE_LIMITED", message: "Demasiadas solicitudes. Intenta más tarde." } },
    headers: { "Retry-After": String(retryAfter) },
  };
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest("Cuerpo JSON invalido");
  }
}

function isProduction(deps: SessionEndpointDeps): boolean {
  return deps.isProduction ?? process.env.NODE_ENV === "production";
}

export async function exchangeSession(request: Request, deps: ExchangeSessionDeps): Promise<EndpointResult> {
  try {
    assertSameOrigin(request);
    const limited = rateLimitGuard(request, "session", deps.rateLimit ?? DEFAULT_RATE_LIMIT);
    if (limited) return limited;

    const { idToken, fullName, phone } = sessionExchangeSchema.parse(await readJsonBody(request));
    const identity = await verifyIdTokenIdentity(deps.auth, idToken);
    const user = await deps.ensureAppUser({
      uid: identity.uid,
      identity: { email: identity.email, emailVerified: identity.emailVerified },
      profile: { fullName: fullName ?? identity.displayName ?? undefined, phone },
    });
    const sessionCookie = await createSessionCookieForIdToken(deps.auth, idToken);
    deps.cookies.set(SESSION_COOKIE_NAME, sessionCookie, sessionCookieOptions(isProduction(deps)));
    return { status: 200, body: { ok: true, profileRequired: !user.profileComplete } };
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return { status, body };
  }
}

export async function readSession(deps: SessionEndpointDeps): Promise<EndpointResult> {
  const cookie = deps.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionCookieForRequest(deps.auth, cookie);
  if (!session) {
    const { status, body } = toErrorResponse(unauthorized("Sesion no valida"));
    return { status, body };
  }
  return { status: 200, body: session };
}

export async function closeSession(request: Request, deps: SessionEndpointDeps): Promise<EndpointResult> {
  try {
    assertSameOrigin(request);
    const limited = rateLimitGuard(request, "logout", deps.rateLimit ?? DEFAULT_RATE_LIMIT);
    if (limited) return limited;

    const cookie = deps.cookies.get(SESSION_COOKIE_NAME)?.value;
    const session = await verifySessionCookieForRequest(deps.auth, cookie);
    if (session) {
      await revokeAllSessions(deps.auth, session.uid);
    }
    deps.cookies.delete(SESSION_COOKIE_NAME);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return { status, body };
  }
}
