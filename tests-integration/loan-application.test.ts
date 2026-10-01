import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits } from "../src/lib/rate-limit";
import { ensureAppUser } from "../src/services/users/ensure-app-user";
import { createLoanApplication, submitLoanApplicationService, getLoanApplication, listLoanApplications } from "../src/services/credit/loan-application-service";
import { exchangeSession } from "../src/services/auth/session-endpoint";
import { seedCreditConfig } from "../src/services/credit/seed-credit-config";

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
const PASSWORD = "loan-app-test-clave-2026";
const createdUids: string[] = [];
const createdLoanIds: string[] = [];

function fakeCookieStore(initial: Record<string, string> = {}) {
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

function buildDeps(cookie?: string) {
  return {
    db,
    auth,
    cookies: fakeCookieStore(cookie ? { __session: cookie } : {}),
  };
}

beforeAll(async () => {
  console.log("[test] sembrando configuración de crédito...");
  await seedCreditConfig(db);
  console.log("[test] configuración de crédito sembrada");
});

afterAll(async () => {
  const failures: string[] = [];
  // Los préstamos se siembran con id automático: sin registro explícito quedaban huérfanos en el
  // proyecto real (el `afterAll` solo borraba el usuario y el préstamo quedaba sin dueño).
  for (const loanId of createdLoanIds) {
    await db
      .doc(`loans/${loanId}`)
      .delete()
      .catch((err: Error) => failures.push(`loans/${loanId}: ${err.message}`));
  }
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

describe("loan-application-service contra Firestore real", () => {
  it("crea borrador para usuario sin historial (tier 1)", async () => {
    const { uid, email } = await createAuthUser("loan-create");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await exchangeAndGetCookie(idToken, "Persona Loan", "+573001234567");

    const result = await createLoanApplication(
      { db },
      { userId: uid, productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
    );

    expect(result.application.userId).toBe(uid);
    expect(result.application.requestedAmountPesos).toBe(50000);
    expect(result.application.status).toBe("DRAFT");
    expect(result.eligibleTier.tier?.position).toBe(1);
    expect(result.eligibleTier.tier?.amountPesos).toBe(50000);
  });

  it("lanza error si monto no coincide con tier", async () => {
    const { uid, email } = await createAuthUser("loan-bad-amount");
    const idToken = await signInForIdToken(email, PASSWORD);
    await exchangeAndGetCookie(idToken);

    await expect(
      createLoanApplication(
        { db },
        { userId: uid, productId: "MICRO_BASICO", requestedAmountPesos: 60000, termInstallments: 4, termFrequency: "MONTHLY" },
      ),
    ).rejects.toThrow("no coincide");
  });

  it("lanza error si usuario tiene préstamo activo", async () => {
    const { uid, email } = await createAuthUser("loan-active");
    const idToken = await signInForIdToken(email, PASSWORD);
    await exchangeAndGetCookie(idToken);

    await db.collection("loans").add({
      userId: uid,
      status: "DISBURSED",
      createdAt: new Date(),
    }).then((ref) => createdLoanIds.push(ref.id));

    await expect(
      createLoanApplication(
        { db },
        { userId: uid, productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
      ),
    ).rejects.toThrow("préstamo activo");
  });

  it("presenta solicitud: DRAFT → SUBMITTED", async () => {
    const { uid, email } = await createAuthUser("loan-submit");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await exchangeAndGetCookie(idToken);

    const createResult = await createLoanApplication(
      { db },
      { userId: uid, productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
    );

    // El ID del documento en Firestore es el applicationNumber
    const appId = createResult.application.applicationNumber;
    expect(appId).toBeTruthy();

    const submitted = await submitLoanApplicationService({ db }, appId, uid);

    expect(submitted.status).toBe("SUBMITTED");

    const getResult = await getLoanApplication({ db }, appId);
    expect(getResult?.status).toBe("SUBMITTED");
  });

  it("lanza error al presentar si no es del usuario", async () => {
    const { uid, email } = await createAuthUser("loan-submit-other");
    const idToken = await signInForIdToken(email, PASSWORD);
    await exchangeAndGetCookie(idToken);

    const createResult = await createLoanApplication(
      { db },
      { userId: uid, productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
    );

    const appId = createResult.application.applicationNumber;

    const { uid: uid2, email: email2 } = await createAuthUser("loan-submit-other2");
    const idToken2 = await signInForIdToken(email2, PASSWORD);
    await exchangeAndGetCookie(idToken2);

    // Mismo 404 que si no existiera: no se revela que la solicitud de otro usuario existe.
    const ajeno = await submitLoanApplicationService({ db }, appId, uid2).catch((e: unknown) => e);
    const inexistente = await submitLoanApplicationService(
      { db },
      `APP-NO-EXISTE-${Date.now()}`,
      uid2,
    ).catch((e: unknown) => e);

    expect((ajeno as { statusCode?: number }).statusCode).toBe(404);
    expect((ajeno as Error).message).toBe((inexistente as Error).message);
  });

  it("lista solicitudes del usuario", async () => {
    const { uid, email } = await createAuthUser("loan-list");
    const idToken = await signInForIdToken(email, PASSWORD);
    await exchangeAndGetCookie(idToken);

    await createLoanApplication(
      { db },
      { userId: uid, productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
    );
    await createLoanApplication(
      { db },
      { userId: uid, productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
    );

    const result = await listLoanApplications({ db }, uid);

    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("numera solicitudes concurrentes sin colisiones (carrera de read-then-write)", async () => {
    // Reproductor del bug: `getNextApplicationNumber` leía el máximo y luego
    // escribía fuera de transacción, así que dos creates simultáneos elegían el
    // mismo número y uno sobrescribía al otro (pérdida de solicitud).
    const { uid: uid1, email: email1 } = await createAuthUser("loan-race-1");
    const { uid: uid2, email: email2 } = await createAuthUser("loan-race-2");
    const { uid: uid3, email: email3 } = await createAuthUser("loan-race-3");
    const [id1, id2, id3] = await Promise.all([
      signInForIdToken(email1, PASSWORD),
      signInForIdToken(email2, PASSWORD),
      signInForIdToken(email3, PASSWORD),
    ]);
    await Promise.all([exchangeAndGetCookie(id1), exchangeAndGetCookie(id2), exchangeAndGetCookie(id3)]);

    const [r1, r2, r3] = await Promise.all([
      createLoanApplication({ db }, { userId: uid1, productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" }),
      createLoanApplication({ db }, { userId: uid2, productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" }),
      createLoanApplication({ db }, { userId: uid3, productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" }),
    ]);

    const numbers = [r1, r2, r3].map((r) => r.application.applicationNumber);
    expect(new Set(numbers).size).toBe(3);

    // Cada solicitud debe seguir existiendo con su propio dueño.
    for (const [result, uid] of [[r1, uid1], [r2, uid2], [r3, uid3]] as const) {
      const persisted = await getLoanApplication({ db }, result.application.applicationNumber);
      expect(persisted?.userId).toBe(uid);
    }
  });
});