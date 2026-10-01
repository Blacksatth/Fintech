import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth } from "firebase-admin/auth";
import { resetRateLimits } from "../../lib/rate-limit";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } from "../../server/auth-session";
import {
  closeSession,
  exchangeSession,
  readSession,
  type CookieStoreLike,
  type ExchangeSessionDeps,
  type SessionEndpointDeps,
} from "./session-endpoint";
import type { EnsureAppUserInput, EnsureAppUserResult } from "../users/ensure-app-user";

interface SetCall {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

function fakeCookieStore(initial: Record<string, string> = {}): CookieStoreLike & {
  sets: SetCall[];
  deletes: string[];
  store: Record<string, string>;
} {
  const store: Record<string, string> = { ...initial };
  const sets: SetCall[] = [];
  const deletes: string[] = [];
  return {
    store,
    sets,
    deletes,
    get: (name: string) => (name in store ? { name, value: store[name] } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      sets.push({ name, value, options });
      store[name] = value;
      return { name, value };
    },
    delete: (name: string) => {
      deletes.push(name);
      delete store[name];
      return { name };
    },
  };
}

function fakeAuth(overrides: Record<string, unknown> = {}): Auth {
  return {
    createSessionCookie: vi.fn(async () => "cookie-creado"),
    verifyIdToken: vi.fn(async () => ({
      uid: "uid-1",
      email: "persona@local.dev",
      email_verified: true,
      firebase: { sign_in_provider: "password" },
    })),
    verifySessionCookie: vi.fn(async () => ({ uid: "uid-1", email: "persona@local.dev" })),
    revokeRefreshTokens: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Auth;
}

function fakeEnsureAppUser(result: Partial<EnsureAppUserResult> = {}) {
  const calls: EnsureAppUserInput[] = [];
  const fn = vi.fn(async (input: EnsureAppUserInput) => {
    calls.push(input);
    return { created: true, profileComplete: true, ...result } as EnsureAppUserResult;
  });
  return { fn, calls };
}

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
  });
}

const generous = { limit: 100, windowMs: 60_000 };

beforeEach(() => {
  resetRateLimits();
});

describe("exchangeSession", () => {
  it("200: cambia el ID token por la cookie de sesión con las opciones correctas", async () => {
    const auth = fakeAuth();
    const cookies = fakeCookieStore();
    const deps: ExchangeSessionDeps = { auth, cookies, ensureAppUser: fakeEnsureAppUser().fn };

    const result = await exchangeSession(
      postRequest({ idToken: "id-token-abc", fullName: "Persona Uno", phone: "+573001234567" }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, profileRequired: false });
    expect(cookies.sets).toHaveLength(1);
    expect(cookies.sets[0].name).toBe(SESSION_COOKIE_NAME);
    expect(cookies.sets[0].value).toBe("cookie-creado");
    expect(cookies.sets[0].options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_MS / 1000,
    });
  });

  it("crea o vincula el usuario de la app con la identidad verificada del token", async () => {
    const ensure = fakeEnsureAppUser();
    const deps: ExchangeSessionDeps = { auth: fakeAuth(), cookies: fakeCookieStore(), ensureAppUser: ensure.fn };

    await exchangeSession(
      postRequest({ idToken: "abc", fullName: "  Persona Uno  ", phone: " +573001234567 " }),
      deps,
    );

    expect(ensure.calls).toHaveLength(1);
    expect(ensure.calls[0].uid).toBe("uid-1");
    expect(ensure.calls[0].identity).toEqual({ email: "persona@local.dev", emailVerified: true });
    expect(ensure.calls[0].profile).toEqual({ fullName: "Persona Uno", phone: "+573001234567" });
  });

  it("usa el nombre del token (Google) cuando el cuerpo no trae perfil", async () => {
    const ensure = fakeEnsureAppUser();
    const auth = fakeAuth({
      verifyIdToken: vi.fn(async () => ({
        uid: "uid-google",
        email: "google@local.dev",
        email_verified: true,
        name: "Persona Google",
        firebase: { sign_in_provider: "google.com" },
      })),
    });
    const deps: ExchangeSessionDeps = { auth, cookies: fakeCookieStore(), ensureAppUser: ensure.fn };

    await exchangeSession(postRequest({ idToken: "abc" }), deps);

    expect(ensure.calls[0].identity.email).toBe("google@local.dev");
    expect(ensure.calls[0].profile).toEqual({ fullName: "Persona Google" });
  });

  it("200 con profileRequired=true si falta el perfil, pero la cookie sí se fija", async () => {
    const ensure = fakeEnsureAppUser({ created: false, profileComplete: false });
    const cookies = fakeCookieStore();
    const deps: ExchangeSessionDeps = { auth: fakeAuth(), cookies, ensureAppUser: ensure.fn };

    const result = await exchangeSession(postRequest({ idToken: "abc" }), deps);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, profileRequired: true });
    expect(cookies.sets).toHaveLength(1);
  });

  it("401 y sin escrituras: el ID token no se puede verificar", async () => {
    const ensure = fakeEnsureAppUser();
    const auth = fakeAuth({
      verifyIdToken: vi.fn(async () => {
        const error = new Error("falso");
        (error as Error & { code: string }).code = "auth/argument-error";
        throw error;
      }),
    });
    const cookies = fakeCookieStore();
    const deps: ExchangeSessionDeps = { auth, cookies, ensureAppUser: ensure.fn };

    const result = await exchangeSession(postRequest({ idToken: "falso" }), deps);

    expect(result.status).toBe(401);
    expect(ensure.fn).not.toHaveBeenCalled();
    expect(cookies.sets).toHaveLength(0);
  });

  it("500 y sin cookie: si el alta del usuario falla, la sesión no se establece", async () => {
    const ensure = fakeEnsureAppUser();
    ensure.fn.mockRejectedValueOnce(new Error("firestore caído"));
    const cookies = fakeCookieStore();
    const deps: ExchangeSessionDeps = { auth: fakeAuth(), cookies, ensureAppUser: ensure.fn };

    const result = await exchangeSession(
      postRequest({ idToken: "abc", fullName: "Persona Uno", phone: "+573001234567" }),
      deps,
    );

    expect(result.status).toBe(500);
    expect(cookies.sets).toHaveLength(0);
  });

  it("400: cuerpo inválido, token ausente o campos extra", async () => {
    const cookies = fakeCookieStore();
    const ensure = fakeEnsureAppUser();
    const deps: ExchangeSessionDeps = { auth: fakeAuth(), cookies, ensureAppUser: ensure.fn };

    for (const body of [{}, { idToken: "" }, { idToken: "abc", role: "ADMIN" }, { idToken: "abc", phone: "123" }]) {
      const result = await exchangeSession(postRequest(body), deps);
      expect(result.status).toBe(400);
    }
    expect(cookies.sets).toHaveLength(0);
    expect(ensure.fn).not.toHaveBeenCalled();
  });

  it("401: ID token que Firebase rechaza, sin fijar cookie", async () => {
    const auth = fakeAuth({
      verifyIdToken: vi.fn(async () => {
        const error = new Error("rechazado");
        (error as Error & { code: string }).code = "auth/argument-error";
        throw error;
      }),
    });
    const cookies = fakeCookieStore();
    const result = await exchangeSession(postRequest({ idToken: "falso" }), { auth, cookies, ensureAppUser: fakeEnsureAppUser().fn });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(cookies.sets).toHaveLength(0);
  });

  it("400: cuerpo que no es JSON válido", async () => {
    const request = new Request("http://localhost:3000/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" },
      body: "{no-es-json",
    });

    const result = await exchangeSession(request, {
      auth: fakeAuth(),
      cookies: fakeCookieStore(),
      ensureAppUser: fakeEnsureAppUser().fn,
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "VALIDATION" } });
  });

  it("403: Origin distinto al host (CSRF)", async () => {
    const cookies = fakeCookieStore();
    const result = await exchangeSession(postRequest({ idToken: "abc" }, { origin: "https://evil.local.dev" }), {
      auth: fakeAuth(),
      cookies,
      ensureAppUser: fakeEnsureAppUser().fn,
    });

    expect(result.status).toBe(403);
    expect(cookies.sets).toHaveLength(0);
  });

  it("429: supera el límite por IP y responde Retry-After", async () => {
    const auth = fakeAuth();
    const cookies = fakeCookieStore();
    const deps: ExchangeSessionDeps = {
      auth,
      cookies,
      ensureAppUser: fakeEnsureAppUser().fn,
      rateLimit: { limit: 2, windowMs: 60_000 },
    };

    expect((await exchangeSession(postRequest({ idToken: "a" }), deps)).status).toBe(200);
    expect((await exchangeSession(postRequest({ idToken: "b" }), deps)).status).toBe(200);

    const limited = await exchangeSession(postRequest({ idToken: "c" }), deps);
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(Number(limited.headers?.["Retry-After"])).toBeGreaterThan(0);
    expect(auth.createSessionCookie).toHaveBeenCalledTimes(2);
  });

  it("el límite es por IP: otra IP no se ve afectada", async () => {
    const deps: ExchangeSessionDeps = {
      auth: fakeAuth(),
      cookies: fakeCookieStore(),
      ensureAppUser: fakeEnsureAppUser().fn,
      rateLimit: { limit: 1, windowMs: 60_000 },
    };

    expect((await exchangeSession(postRequest({ idToken: "a" }, { "x-forwarded-for": "1.1.1.1" }), deps)).status).toBe(200);
    expect((await exchangeSession(postRequest({ idToken: "b" }, { "x-forwarded-for": "1.1.1.1" }), deps)).status).toBe(429);
    expect((await exchangeSession(postRequest({ idToken: "c" }, { "x-forwarded-for": "2.2.2.2" }), deps)).status).toBe(200);
  });

  it("usa el límite por defecto cuando no se inyecta", async () => {
    const result = await exchangeSession(postRequest({ idToken: "abc" }), {
      auth: fakeAuth(),
      cookies: fakeCookieStore(),
      ensureAppUser: fakeEnsureAppUser().fn,
    });

    expect(result.status).toBe(200);
  });
});
describe("readSession", () => {
  it("200: cookie válida verificada con checkRevoked=true", async () => {
    const auth = fakeAuth();
    const cookies = fakeCookieStore({ [SESSION_COOKIE_NAME]: "cookie-ok" });

    const result = await readSession({ auth, cookies });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ uid: "uid-1", email: "persona@local.dev" });
    expect(auth.verifySessionCookie).toHaveBeenCalledWith("cookie-ok", true);
  });

  it("401: sin cookie", async () => {
    const result = await readSession({ auth: fakeAuth(), cookies: fakeCookieStore() });
    expect(result.status).toBe(401);
  });

  it("401: cookie revocada o inválida", async () => {
    const auth = fakeAuth({
      verifySessionCookie: vi.fn(async () => {
        const error = new Error("revocada");
        (error as Error & { code: string }).code = "auth/session-cookie-revoked";
        throw error;
      }),
    });
    const cookies = fakeCookieStore({ [SESSION_COOKIE_NAME]: "cookie-revocada" });

    expect((await readSession({ auth, cookies })).status).toBe(401);
  });
});

describe("closeSession", () => {
  it("200: revoca los refresh tokens y borra la cookie", async () => {
    const auth = fakeAuth();
    const cookies = fakeCookieStore({ [SESSION_COOKIE_NAME]: "cookie-ok" });

    const result = await closeSession(postRequest({}), { auth, cookies });

    expect(result.status).toBe(200);
    expect(auth.revokeRefreshTokens).toHaveBeenCalledWith("uid-1");
    expect(cookies.deletes).toEqual([SESSION_COOKIE_NAME]);
    expect(cookies.store[SESSION_COOKIE_NAME]).toBeUndefined();
  });

  it("200 e idempotente sin cookie: no revoca nada pero responde OK", async () => {
    const auth = fakeAuth();
    const result = await closeSession(postRequest({}), { auth, cookies: fakeCookieStore() });

    expect(result.status).toBe(200);
    expect(auth.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it("200: cookie inválida o ya revocada también se borra", async () => {
    const auth = fakeAuth({
      verifySessionCookie: vi.fn(async () => {
        const error = new Error("revocada");
        (error as Error & { code: string }).code = "auth/session-cookie-revoked";
        throw error;
      }),
    });
    const cookies = fakeCookieStore({ [SESSION_COOKIE_NAME]: "cookie-revocada" });

    const result = await closeSession(postRequest({}), { auth, cookies });

    expect(result.status).toBe(200);
    expect(auth.revokeRefreshTokens).not.toHaveBeenCalled();
    expect(cookies.deletes).toEqual([SESSION_COOKIE_NAME]);
  });

  it("403: Origin distinto al host", async () => {
    const result = await closeSession(postRequest({}, { origin: "https://evil.local.dev" }), {
      auth: fakeAuth(),
      cookies: fakeCookieStore({ [SESSION_COOKIE_NAME]: "cookie-ok" }),
    });

    expect(result.status).toBe(403);
  });
});

describe("límite por defecto de los endpoints", () => {
  it("acepta deps sin rateLimit en logout y readSession", async () => {
    const cookies = fakeCookieStore({ [SESSION_COOKIE_NAME]: "cookie-ok" });
    const deps: SessionEndpointDeps = { auth: fakeAuth(), cookies, rateLimit: generous };

    expect((await readSession(deps)).status).toBe(200);
    expect((await closeSession(postRequest({}), deps)).status).toBe(200);
  });
});
