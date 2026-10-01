import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits } from "../src/lib/rate-limit";
import { ensureAppUser } from "../src/services/users/ensure-app-user";
import { seedCreditConfig } from "../src/services/credit/seed-credit-config";
import { calculateAndSaveScore, getCreditScore } from "../src/services/credit/scoring-service";
import { createLoanApplication, submitLoanApplicationService } from "../src/services/credit/loan-application-service";
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
const PASSWORD = "scoring-test-clave-2026";
const createdUids: string[] = [];

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

async function seedCreditConfigIfNeeded() {
  try {
    const productSnap = await db.collection("credit_products").doc("MICRO_BASICO").get();
    if (!productSnap.exists) {
      await seedCreditConfig(db);
    }
  } catch {
    await seedCreditConfig(db);
  }
}

afterAll(async () => {
  const failures: string[] = [];
  for (const uid of createdUids) {
    await db.collection("credit_scores").doc(uid).delete().catch(() => {});
    await db.collection("credit_scores").doc(`${uid}_*`).delete().catch(() => {});
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

beforeAll(async () => {
  await seedCreditConfigIfNeeded();
});

beforeEach(() => {
  resetRateLimits();
});

describe("scoring-service contra Firestore real", () => {
  it("calcula y guarda score para usuario nuevo", async () => {
    const { uid, email } = await createAuthUser("scoring-user");
    const idToken = await signInForIdToken(email, PASSWORD);
    await exchangeAndGetCookie(idToken);

    const riskContext = {
      userId: uid,
      identityVerified: true,
      incomeVerifiable: true,
      monthlyIncomeRange: "2M-4M",
      debtToIncomeRatio: 0.3,
      loanHistoryCount: 1,
      paymentHistoryScore: 80,
      previousDelinquency: false,
      applicationCount: 1,
    };

    const result = await calculateAndSaveScore(
      {
        db,
        riskEngine: (await import("@/server/risk-engine")).createDefaultRiskEngine(),
        auditLog: async (action, metadata) => console.log(`AUDIT: ${action}`, metadata),
      },
      { userId: uid, riskContext },
    );

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(result.riskLevel);
    expect(result.factors).toHaveLength(7);
    expect(result.modelVersion).toBeTruthy();

    // Verificar que se guardó en Firestore
    const savedScore = await getCreditScore({ db }, uid);
    expect(savedScore).not.toBeNull();
    expect(savedScore?.score).toBe(result.score);
    expect(savedScore?.riskLevel).toBe(result.riskLevel);
  });

  it("retorna score guardado al consultar", async () => {
    const { uid, email } = await createAuthUser("scoring-get");
    const idToken = await signInForIdToken(email, PASSWORD);
    await exchangeAndGetCookie(idToken);

    const riskContext = {
      userId: uid,
      identityVerified: true,
      incomeVerifiable: true,
      monthlyIncomeRange: "4M-8M",
      debtToIncomeRatio: 0.15,
      loanHistoryCount: 3,
      paymentHistoryScore: 95,
      previousDelinquency: false,
      applicationCount: 1,
    };

    await calculateAndSaveScore(
      {
        db,
        riskEngine: (await import("@/server/risk-engine")).createDefaultRiskEngine(),
        auditLog: async (action, metadata) => console.log(`AUDIT: ${action}`, metadata),
      },
      { userId: uid, riskContext },
    );

    const score = await getCreditScore({ db }, uid);
    expect(score).not.toBeNull();
    expect(score?.score).toBeGreaterThanOrEqual(70);
    expect(score?.riskLevel).toBe("LOW");
  });

  it("integración completa: crear solicitud → presentar → score calculado", async () => {
    const { uid, email } = await createAuthUser("scoring-full");
    const idToken = await signInForIdToken(email, PASSWORD);
    const cookie = await exchangeAndGetCookie(idToken);

    // Crear solicitud
    const createResult = await createLoanApplication(
      { db },
      { userId: uid, productId: "MICRO_BASICO", requestedAmountPesos: 50000, termInstallments: 4, termFrequency: "MONTHLY" },
    );
    expect(createResult.application.status).toBe("DRAFT");
    const appId = createResult.application.applicationNumber;

    // Presentar solicitud
    const submitted = await submitLoanApplicationService({ db }, appId, uid);
    expect(submitted.status).toBe("SUBMITTED");

    // Verificar que se calculó el score
    const score = await getCreditScore({ db }, uid, appId);
    expect(score).not.toBeNull();
    expect(score?.score).toBeGreaterThanOrEqual(0);
    expect(score?.score).toBeLessThanOrEqual(100);
    expect(score?.applicationId).toBe(appId);
    expect(score?.factors).toHaveLength(7);
    expect(score?.modelVersion).toBeTruthy();
  });
});