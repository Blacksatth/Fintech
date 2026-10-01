import type { Auth } from "firebase-admin/auth";
import { unauthorized } from "../lib/errors";

export const SESSION_COOKIE_NAME = "__session";

export const SESSION_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  uid: string;
  email: string | null;
}

/** Identidad verificada del ID token que envía el navegador (claims de Firebase). */
export interface VerifiedIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}

export function sessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction,
    path: "/",
    maxAge: SESSION_MAX_AGE_MS / 1000,
  };
}

/**
 * Verifica el ID token del cliente (firma,Audience, emisor y revocación) para
 * poder leer su identidad antes de emitir la cookie. El navegador no es una
 * fuente confiable: aquí solo se usa lo que Firebase ya validó.
 */
export async function verifyIdTokenIdentity(auth: Auth, idToken: string): Promise<VerifiedIdentity> {
  let decoded: Awaited<ReturnType<Auth["verifyIdToken"]>>;
  try {
    decoded = await auth.verifyIdToken(idToken);
  } catch {
    throw unauthorized("El token de sesión no es válido");
  }
  if (!decoded.email) {
    throw unauthorized("El token no trae un correo verificado");
  }
  return {
    uid: decoded.uid,
    email: decoded.email,
    emailVerified: decoded.email_verified === true,
    displayName: typeof decoded.name === "string" ? decoded.name : null,
  };
}

export async function createSessionCookieForIdToken(auth: Auth, idToken: string): Promise<string> {
  try {
    return await auth.createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_MS });
  } catch {
    throw unauthorized("El token de sesión no es válido");
  }
}

export async function verifySessionCookieForRequest(
  auth: Auth,
  cookie: string | undefined,
): Promise<SessionUser | null> {
  if (!cookie) return null;
  try {
    const decoded = await auth.verifySessionCookie(cookie, true);
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch {
    return null;
  }
}

export async function revokeAllSessions(auth: Auth, uid: string): Promise<void> {
  await auth.revokeRefreshTokens(uid);
}
