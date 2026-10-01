import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits } from "../src/lib/rate-limit";
import {
  SESSION_COOKIE_NAME,
  createSessionCookieForIdToken,
  verifySessionCookieForRequest,
} from "../src/server/auth-session";
import {
  exchangeSession,
  readSession,
  type CookieStoreLike,
  type ExchangeSessionDeps,
} from "../src/services/auth/session-endpoint";
import { ensureAppUser } from "../src/services/users/ensure-app-user";

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
const PASSWORD = "sesion-test-clave-2026";
const createdUids: string[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function cookieClaims(cookie: string): Record<string, unknown> {
  const payload = cookie.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

/**
 * `revokeRefreshTokens` sella `tokensValidAfterTime` con el reloj LOCAL, mientras
 * que el `auth_time` de la cookie lo emite Firebase. Si el reloj local va atrasado,
 * la revocación queda con un instante anterior al de la cookie y no se aplica
 * (comportamiento documentado en el SDK: el reloj del servidor debe estar
 * sincronizado). Esperamos a que el reloj local pase ese segundo para que el test
 * sea determinista en cualquier máquina.
 */
async function waitForLocalClockToPass(authTime: number): Promise<number> {
  const waitMs = Math.max(0, (authTime - Math.floor(Date.now() / 1000) + 2) * 1000);
  if (waitMs > 0) await sleep(waitMs);
  return waitMs;
}

function fakeCookieStore(initial: Record<string, string> = {}): CookieStoreLike & { store: Record<string, string> } {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    get: (name) => (name in store ? { name, value: store[name] } : undefined),
    set: (name, value) => {
      store[name] = value;
      return { name, value };
    },
    delete: (name) => {
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

function exchangeDeps(
  cookies: CookieStoreLike,
  rateLimit?: { limit: number; windowMs: number },
): ExchangeSessionDeps {
  return { auth, cookies, ensureAppUser: (input) => ensureAppUser(db, input), rateLimit };
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

describe("session cookies contra Firebase Auth real", () => {
  it("registra un usuario, cambia el ID token por cookie y la verifica con checkRevoked=true", async () => {
    const { uid, email } = await createAuthUser("sesion");
    const idToken = await signInForIdToken(email, PASSWORD);

    const cookie = await createSessionCookieForIdToken(auth, idToken);
    expect(cookie.split(".").length).toBeGreaterThanOrEqual(3);
    expect(cookie).not.toContain(idToken);

    const session = await verifySessionCookieForRequest(auth, cookie);
    expect(session?.uid).toBe(uid);
    expect(session?.email).toBe(email);
  });

  it("rechaza una cookie de sesión falsa", async () => {
    expect(await verifySessionCookieForRequest(auth, "no-es-una-cookie")).toBeNull();
    expect(await verifySessionCookieForRequest(auth, undefined)).toBeNull();
  });

  it("aplica el chequeo de revocación: con la cuenta deshabilitada la cookie se rechaza y sin chequeo sigue siendo válida", async () => {
    const { uid, email } = await createAuthUser("sesion-deshabilitado");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await createSessionCookieForIdToken(auth, idToken);

    expect(await verifySessionCookieForRequest(auth, cookie)).not.toBeNull();

    await auth.updateUser(uid, { disabled: true });

    expect(await verifySessionCookieForRequest(auth, cookie)).toBeNull();
    const sinChequeo = await auth.verifySessionCookie(cookie).then((d) => d.uid).catch(() => null);
    expect(sinChequeo).toBe(uid);

    await auth.updateUser(uid, { disabled: false });
  });

  it("tras revokeRefreshTokens la cookie existente deja de verificarse", async () => {
    const { uid, email } = await createAuthUser("sesion-revoque");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await createSessionCookieForIdToken(auth, idToken);
    expect(await verifySessionCookieForRequest(auth, cookie)).not.toBeNull();

    const waitedMs = await waitForLocalClockToPass(cookieClaims(cookie).auth_time as number);
    if (waitedMs > 0) {
      console.warn(`reloj local desfasado: se esperaron ${waitedMs}ms antes de revocar`);
    }

    await auth.revokeRefreshTokens(uid);

    expect(await verifySessionCookieForRequest(auth, cookie)).toBeNull();
    const sinChequeo = await auth.verifySessionCookie(cookie).then((d) => d.uid).catch(() => null);
    expect(sinChequeo).toBe(uid);
  }, 180_000);

  it("el endpoint fija la cookie HTTP-only, crea el usuario en Firestore y readSession la reconoce", async () => {
    const { uid, email } = await createAuthUser("sesion-endpoint");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookies = fakeCookieStore();

    const exchanged = await exchangeSession(
      sessionRequest({ idToken, fullName: "Persona Endpoint", phone: "+573001234567" }),
      exchangeDeps(cookies),
    );
    expect(exchanged.status).toBe(200);
    expect(exchanged.body).toEqual({ ok: true, profileRequired: false });
    expect(cookies.store[SESSION_COOKIE_NAME]).toBeTruthy();

    const userDoc = await db.doc(`users/${uid}`).get();
    expect(userDoc.exists).toBe(true);
    expect(userDoc.data()).toMatchObject({
      email,
      fullName: "Persona Endpoint",
      phone: "+573001234567",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    expect(await db.doc(`user_profiles/${uid}`).get()).toMatchObject({ exists: true });

    const read = await readSession({ auth, cookies });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ email });
  });

  it("sin nombre ni teléfono responde profileRequired y no escribe documentos a medias", async () => {
    const { uid, email } = await createAuthUser("sesion-perfil-incompleto");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookies = fakeCookieStore();

    const first = await exchangeSession(sessionRequest({ idToken }), exchangeDeps(cookies));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, profileRequired: true });
    expect(cookies.store[SESSION_COOKIE_NAME]).toBeTruthy();
    expect((await db.doc(`users/${uid}`).get()).exists).toBe(false);
    expect((await db.doc(`user_profiles/${uid}`).get()).exists).toBe(false);

    const second = await exchangeSession(
      sessionRequest({ idToken, fullName: "Perfil Completo", phone: "+573001234567" }),
      exchangeDeps(cookies),
    );
    expect(second.body).toEqual({ ok: true, profileRequired: false });
    expect((await db.doc(`users/${uid}`).get()).data()).toMatchObject({ fullName: "Perfil Completo" });
  });

  it("un segundo ingreso no pisa el usuario ya creado", async () => {
    const { uid, email } = await createAuthUser("sesion-no-pisa");
    const idToken = await signInForIdToken(email, PASSWORD);

    await exchangeSession(
      sessionRequest({ idToken, fullName: "Nombre Original", phone: "+573001234567" }),
      exchangeDeps(fakeCookieStore()),
    );
    const otra = await exchangeSession(
      sessionRequest({ idToken, fullName: "Nombre Distinto", phone: "+573009999999" }),
      exchangeDeps(fakeCookieStore()),
    );

    expect(otra.status).toBe(200);
    expect(otra.body).toEqual({ ok: true, profileRequired: false });
    expect((await db.doc(`users/${uid}`).get()).data()).toMatchObject({
      fullName: "Nombre Original",
      phone: "+573001234567",
    });
  });

  it("el endpoint responde 401 con un ID token falso y 429 al superar el límite (cada intento cuenta)", async () => {
    const { email } = await createAuthUser("sesion-429");
    const validIdToken = await signInForIdToken(email, PASSWORD);
    const cookies = fakeCookieStore();
    const deps = exchangeDeps(cookies, { limit: 2, windowMs: 60_000 });

    expect((await exchangeSession(sessionRequest({ idToken: "token.inventado.falso" }), deps)).status).toBe(401);
    expect((await exchangeSession(sessionRequest({ idToken: validIdToken }), deps)).status).toBe(200);

    const limited = await exchangeSession(sessionRequest({ idToken: validIdToken }), deps);
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
});
