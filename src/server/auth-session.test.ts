import { describe, expect, it, vi } from "vitest";
import type { Auth } from "firebase-admin/auth";
import { AppError } from "../lib/errors";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  createSessionCookieForIdToken,
  revokeAllSessions,
  sessionCookieOptions,
  verifySessionCookieForRequest,
} from "./auth-session";

function fakeAuth(overrides: Record<string, unknown> = {}): Auth {
  return {
    createSessionCookie: vi.fn(async (idToken: string, options: { expiresIn: number }) => {
      return `cookie::${idToken}::${options.expiresIn}`;
    }),
    verifySessionCookie: vi.fn(async (cookie: string, checkRevoked?: boolean) => {
      return { uid: "uid-1", email: "persona@local.dev", checkRevoked };
    }),
    revokeRefreshTokens: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Auth;
}

function adminError(code: string): Error {
  const error = new Error(`admin:${code}`);
  (error as Error & { code: string }).code = code;
  return error;
}

describe("constantes de sesión", () => {
  it("usa la cookie __session y una vigencia de 5 días (dentro del máximo de 14 de Firebase)", () => {
    expect(SESSION_COOKIE_NAME).toBe("__session");
    expect(SESSION_MAX_AGE_MS).toBe(5 * 24 * 60 * 60 * 1000);
    expect(SESSION_MAX_AGE_MS).toBeLessThanOrEqual(14 * 24 * 60 * 60 * 1000);
  });
});

describe("sessionCookieOptions", () => {
  it("es HTTP-only, SameSite=Lax y path raíz en desarrollo", () => {
    const options = sessionCookieOptions(false);
    expect(options).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: SESSION_MAX_AGE_MS / 1000,
    });
  });

  it("exige Secure en producción", () => {
    expect(sessionCookieOptions(true).secure).toBe(true);
  });
});

describe("createSessionCookieForIdToken", () => {
  it("delega en createSessionCookie con el expiresIn de 5 días", async () => {
    const auth = fakeAuth();
    const cookie = await createSessionCookieForIdToken(auth, "id-token-abc");

    expect(cookie).toBe(`cookie::id-token-abc::${SESSION_MAX_AGE_MS}`);
    expect(auth.createSessionCookie).toHaveBeenCalledWith("id-token-abc", { expiresIn: SESSION_MAX_AGE_MS });
  });

  it("traduce un ID token inválido a 401 sin filtrar el motivo de Firebase", async () => {
    const auth = fakeAuth({
      createSessionCookie: vi.fn(async () => {
        throw adminError("auth/argument-error");
      }),
    });

    await expect(createSessionCookieForIdToken(auth, "basura")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      statusCode: 401,
    });
    await expect(createSessionCookieForIdToken(auth, "basura")).rejects.toThrow(/no es válido/i);
  });
});

describe("verifySessionCookieForRequest", () => {
  it("verifica con checkRevoked=true y devuelve uid y email", async () => {
    const auth = fakeAuth();
    const session = await verifySessionCookieForRequest(auth, "cookie-valor");

    expect(session).toEqual({ uid: "uid-1", email: "persona@local.dev" });
    expect(auth.verifySessionCookie).toHaveBeenCalledWith("cookie-valor", true);
  });

  it("devuelve null si la cookie no existe", async () => {
    const auth = fakeAuth();
    expect(await verifySessionCookieForRequest(auth, undefined)).toBeNull();
    expect(auth.verifySessionCookie).not.toHaveBeenCalled();
  });

  it("devuelve null cuando Firebase rechaza la cookie (inválida, expirada o revocada)", async () => {
    for (const code of ["auth/session-cookie-revoked", "auth/invalid-session-cookie", "auth/argument-error"]) {
      const auth = fakeAuth({
        verifySessionCookie: vi.fn(async () => {
          throw adminError(code);
        }),
      });
      expect(await verifySessionCookieForRequest(auth, "cookie-valor")).toBeNull();
    }
  });
});

describe("revokeAllSessions", () => {
  it("revoca los refresh tokens del uid", async () => {
    const auth = fakeAuth();
    await revokeAllSessions(auth, "uid-9");
    expect(auth.revokeRefreshTokens).toHaveBeenCalledWith("uid-9");
  });

  it("propaga el error si la revocación falla", async () => {
    const auth = fakeAuth({
      revokeRefreshTokens: vi.fn(async () => {
        throw adminError("auth/user-not-found");
      }),
    });
    await expect(revokeAllSessions(auth, "uid-9")).rejects.toThrow(/admin:auth\/user-not-found/);
  });
});

describe("errores de sesión", () => {
  it("AppError conserva código y status para el mapeo HTTP", () => {
    const error = new AppError("UNAUTHORIZED", "x", 401);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.statusCode).toBe(401);
  });
});
