import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits } from "../src/lib/rate-limit";
import { ensureAppUser } from "../src/services/users/ensure-app-user";
import { getMe, patchMeProfile, type MeDeps } from "../src/services/auth/me-service";
import { exchangeSession } from "../src/services/auth/session-endpoint";

const projectId = process.env.FIREBASE_PROJECT_ID;
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
if (!projectId || !apiKey) {
  throw new Error("FIREBASE_PROJECT_ID y NEXT_PUBLIC_FIREBASE_API_KEY requeridas. Revisa .env");
}
if (getApps().length === 0) {
  initializeApp({ projectId });
}

const auth = getAuth();
const db = getFirestore();
const PASSWORD = "me-test-clave-2026";
const createdUids: string[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function cookieClaims(cookie: string): Record<string, unknown> {
  const payload = cookie.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

async function waitForLocalClockToPass(authTime: number): Promise<number> {
  const waitMs = Math.max(0, (authTime - Math.floor(Date.now() / 1000) + 2) * 1000);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  return waitMs;
}

/**
 * Desfase del reloj local frente al servidor (ms, positivo = local adelantado).
 * `revokeRefreshTokens` sella `tokensValidAfterTime` con el reloj del entorno: si
 * el local está atrasado, el sello queda por detrás del `auth_time` de la cookie y
 * la revocación no se aplica. AGENTS.md: medir el desfase antes de tocar el código.
 */
async function measureClockSkewMs(): Promise<number> {
  const res = await fetch("https://www.google.com/generate_204");
  const serverMs = Date.parse(res.headers.get("date") ?? "");
  if (Number.isNaN(serverMs)) {
    throw new Error("no se pudo leer la fecha del servidor para medir el desfase");
  }
  return Date.now() - serverMs;
}

/** Más allá de esto el reloj está tan roto que el test no puede ser concluyente. */
const MAX_TOLERATED_SKEW_MS = 120_000;

type CookieStoreLike = {
  get(name: string): { name: string; value: string } | undefined;
  set(name: string, value: string, options: unknown): unknown;
  delete(name: string): unknown;
};

interface FakeCookieStore extends CookieStoreLike {
  store: Record<string, string>;
}

function fakeCookieStore(initial: Record<string, string> = {}): FakeCookieStore {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    get: (name: string) => (name in store ? { name, value: store[name] } : undefined),
    set: (name: string, value: string) => {
      store[name] = value;
      return { name, value };
    },
    delete: (name: string) => {
      delete store[name];
      return { name };
    },
  };
}

async function createAuthUser(prefix: string): Promise<{ uid: string; email: string }> {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@local.dev`;
  const user = await auth.createUser({ email, password: PASSWORD });
  createdUids.push(user.uid);
  return { uid: user.uid, email };
}

async function signInForIdToken(email: string, password: string): Promise<string> {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = (await response.json()) as { idToken?: string; error?: { message?: string } };
  if (!response.ok || !body.idToken) {
    throw new Error(`signInWithPassword ${response.status}: ${body.error?.message ?? "sin idToken"}`);
  }
  return body.idToken;
}

function sessionRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
}

async function exchangeAndGetCookie(
  idToken: string,
  fullName: string = "Persona Test",
  phone: string = "+573001234567",
): Promise<string> {
  const cookies = fakeCookieStore();
  const exchanged = await exchangeSession(sessionRequest({ idToken, fullName, phone }), {
    auth,
    cookies,
    ensureAppUser: (input) => ensureAppUser(db, input),
    rateLimit: { limit: 100, windowMs: 60_000 },
  });
  expect(exchanged.status).toBe(200);
  const cookie = cookies.store.__session;
  expect(cookie).toBeTruthy();
  return cookie;
}

function buildMeDeps(cookie?: string): MeDeps {
  return {
    auth,
    db,
    cookies: fakeCookieStore(cookie ? { __session: cookie } : {}),
  };
}

afterAll(async () => {
  const failures: string[] = [];
  for (const uid of createdUids) {
    await db
      .doc(`users/${uid}`)
      .delete()
      .catch((err: Error) => failures.push(`users/${uid}: ${err.message}`));
    await db
      .doc(`user_profiles/${uid}`)
      .delete()
      .catch((err: Error) => failures.push(`user_profiles/${uid}: ${err.message}`));
    await auth.deleteUser(uid).catch((err: Error) => failures.push(`auth/${uid}: ${err.message}`));
  }
  if (failures.length > 0) throw new Error(`limpieza incompleta: ${failures.join("; ")}`);
});

beforeEach(() => {
  resetRateLimits();
});

describe("getMe contra Firebase Auth real", () => {
  it("200: devuelve el perfil del usuario autenticado", async () => {
    const { uid, email } = await createAuthUser("me-get");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await exchangeAndGetCookie(idToken, "Persona Get", "+573001234567");

    const result = await getMe(buildMeDeps(cookie));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      uid,
      email,
      fullName: "Persona Get",
      phone: "+573001234567",
      role: "CUSTOMER",
      status: "ACTIVE",
      profile: {
        city: null,
        occupation: null,
        monthlyIncomeRange: null,
        updatedAt: expect.any(Number),
      },
    });
  });

  it("401: sin cookie de sesión", async () => {
    const result = await getMe(buildMeDeps());

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("401: con cookie inválida", async () => {
    const result = await getMe(buildMeDeps("cookie-invalida"));

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("401: con cookie revocada", async () => {
    const { uid, email } = await createAuthUser("me-revoke");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await exchangeAndGetCookie(idToken);

    const before = await getMe(buildMeDeps(cookie));
    expect(before.status).toBe(200);

    const authTime = Number(cookieClaims(cookie).auth_time);
    expect(Number.isFinite(authTime)).toBe(true);

    const skewMs = await measureClockSkewMs();
    if (Math.abs(skewMs) > MAX_TOLERATED_SKEW_MS) {
      throw new Error(
        `reloj local desfasado ${Math.round(skewMs / 1000)}s: sincroniza NTP (w32tm /resync) para verificar la revocación`,
      );
    }

    // El sello de revocación usa el reloj del entorno; con desfase queda por detrás
    // de auth_time. Esperamos a que el reloj local supere auth_time para que el
    // sello sea estrictamente mayor y la cookie quede invalidada.
    await waitForLocalClockToPass(authTime);

    await auth.revokeRefreshTokens(uid);

    const after = await getMe(buildMeDeps(cookie));
    expect(after.status).toBe(401);
    expect(after.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  }, 180_000);
});

describe("patchMeProfile contra Firebase Auth real", () => {
  it("200: actualiza el perfil del usuario autenticado", async () => {
    const { uid, email } = await createAuthUser("me-patch");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await exchangeAndGetCookie(idToken, "Persona Patch", "+573001234567");

    const result = await patchMeProfile(buildMeDeps(cookie), { city: "Bogotá", occupation: "Ingeniero" });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      profile: {
        city: "Bogotá",
        occupation: "Ingeniero",
        monthlyIncomeRange: null,
        updatedAt: expect.any(Number),
      },
    });

    const profileSnap = await db.doc(`user_profiles/${uid}`).get();
    expect(profileSnap.data()?.city).toBe("Bogotá");
    expect(profileSnap.data()?.occupation).toBe("Ingeniero");
  });

  it("200: actualiza monthlyIncomeRange con valor válido", async () => {
    const { uid, email } = await createAuthUser("me-patch-range");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await exchangeAndGetCookie(idToken);

    const result = await patchMeProfile(buildMeDeps(cookie), { monthlyIncomeRange: "2M-4M" });

    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; profile: { monthlyIncomeRange: string | null } };
    expect(body.profile.monthlyIncomeRange).toBe("2M-4M");

    const profileSnap = await db.doc(`user_profiles/${uid}`).get();
    expect(profileSnap.data()?.monthlyIncomeRange).toBe("2M-4M");
  });

  it("400: rechaza monthlyIncomeRange inválido", async () => {
    const { email } = await createAuthUser("me-patch-bad-range");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await exchangeAndGetCookie(idToken);

    const result = await patchMeProfile(buildMeDeps(cookie), { monthlyIncomeRange: "INVALIDO" });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "VALIDATION" } });
  });

  it("400: sin campos válidos para actualizar", async () => {
    const { email } = await createAuthUser("me-patch-empty");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await exchangeAndGetCookie(idToken);

    const result = await patchMeProfile(buildMeDeps(cookie), { campoInexistente: "valor" } as Record<string, unknown>);

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "VALIDATION" } });
  });

  it("401: sin cookie de sesión", async () => {
    const result = await patchMeProfile(buildMeDeps(), { city: "Medellín" });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("limpia campos vacíos poniéndolos a null", async () => {
    const { uid, email } = await createAuthUser("me-patch-null");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await exchangeAndGetCookie(idToken);

    await db.doc(`user_profiles/${uid}`).set({ city: "Bogotá", updatedAt: new Date() }, { merge: true });

    const result = await patchMeProfile(buildMeDeps(cookie), { city: "" });

    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; profile: { city: string | null } };
    expect(body.profile.city).toBeNull();

    const profileSnap = await db.doc(`user_profiles/${uid}`).get();
    expect(profileSnap.data()?.city).toBeUndefined();
  });
});