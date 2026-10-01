import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { seedCreditConfig } from "../src/services/credit/seed-credit-config";

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID requerida para tests de integracion. Revisa .env");
}
if (getApps().length === 0) {
  initializeApp({ projectId });
}

const db = getFirestore();
const createdDocs: Array<{ collection: string; id: string }> = [];

/**
 * Config que el proyecto real necesita y que este test NO debe borrar jamás.
 * `seedCreditConfig` las devuelve en `configCreated` porque las escribe si faltan,
 * pero no son propiedad del test.
 */
const SHARED_CONFIG = ["system_config/", "risk_rules/"];

function trackDelete(collection: string, id: string) {
  createdDocs.push({ collection, id });
}

/** Registra solo lo que el test creó de verdad, nunca la config compartida. */
function trackSeedResult(configCreated: string[]) {
  for (const path of configCreated) {
    if (SHARED_CONFIG.some((prefix) => path.startsWith(prefix))) continue;
    const [collection, id] = path.split("/");
    trackDelete(collection, id);
  }
}

async function deleteDoc(collection: string, id: string) {
  try {
    await db.collection(collection).doc(id).delete();
  } catch {
    // ignore
  }
}

function uniqueProductCode(): string {
  return `MICRO_TEST_${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function cleanTrackedDocs(): Promise<string[]> {
  const failures: string[] = [];
  for (const { collection, id } of createdDocs) {
    await deleteDoc(collection, id).catch((err: Error) => failures.push(`${collection}/${id}: ${err.message}`));
  }
  createdDocs.length = 0;
  return failures;
}

/** Invariante: la limpieza del test jamás puede borrar la config compartida. */
async function assertSharedConfigAlive(): Promise<string> {
  const missing: string[] = [];
  for (const id of ["delinquency", "scoring", "session", "loan"]) {
    const snap = await db.collection("system_config").doc(id).get();
    if (!snap.exists) missing.push(`system_config/${id}`);
  }
  const rules = await db.collection("risk_rules").limit(1).get();
  if (rules.empty) missing.push("risk_rules/*");
  return missing.join(", ");
}

afterEach(async () => {
  const failures = await cleanTrackedDocs();
  const missing = await assertSharedConfigAlive();
  if (missing) throw new Error(`la limpieza del test borro config compartida: ${missing}`);
  if (failures.length > 0) throw new Error(`limpieza incompleta: ${failures.join("; ")}`);
});

afterAll(async () => {
  const failures = await cleanTrackedDocs();
  if (failures.length > 0) throw new Error(`limpieza incompleta: ${failures.join("; ")}`);
});

describe("seedCreditConfig contra Firestore real", () => {
  it("crea producto, tiers y config por defecto", async () => {
    const productCode = uniqueProductCode();
    const result = await seedCreditConfig(db, productCode);

    expect(result.productCode).toBe(productCode);
    expect(result.tiersCreated).toBe(3);
    expect(result.configCreated.length).toBeGreaterThan(0);

    for (const path of result.configCreated) {
      const [collection, id] = path.split("/");
      const snap = await db.collection(collection).doc(id).get();
      expect(snap.exists).toBe(true);
    }

    const productSnap = await db.collection("credit_products").doc(productCode).get();
    expect(productSnap.exists).toBe(true);
    expect(productSnap.data()?.name).toBe("Microcrédito Básico");

    trackSeedResult(result.configCreated);
  });

  it("es idempotente: segunda ejecución no duplica", async () => {
    const productCode = uniqueProductCode();
    const first = await seedCreditConfig(db, productCode);
    trackSeedResult(first.configCreated);

    const second = await seedCreditConfig(db, productCode);

    expect(second.tiersCreated).toBe(0);
    expect(second.configCreated).toEqual([]);
  });

  it("verifica estructura de tier 1", async () => {
    const productCode = uniqueProductCode();
    const result = await seedCreditConfig(db, productCode);
    trackSeedResult(result.configCreated);

    const tier1Snap = await db.collection("product_tiers").doc(`${productCode}_1`).get();
    expect(tier1Snap.exists).toBe(true);
    const tier1 = tier1Snap.data()!;
    expect(tier1.productCode).toBe(productCode);
    expect(tier1.position).toBe(1);
    expect(tier1.amountPesos).toBe(50000);
    expect(tier1.minScore).toBe(60);
    expect(tier1.isActive).toBe(true);
  });

  it("verifica estructura de system_config/delinquency", async () => {
    const productCode = uniqueProductCode();
    const result = await seedCreditConfig(db, productCode);
    trackSeedResult(result.configCreated);

    const configSnap = await db.collection("system_config").doc("delinquency").get();
    expect(configSnap.exists).toBe(true);
    const config = configSnap.data()!;
    expect(config.value).toEqual({ dueSoonDays: 3, overdueDays: 1, defaultDays: 30 });
    expect(config.updatedBy).toBe("SEED");
  });

  it("verifica risk_rules creadas", async () => {
    const productCode = uniqueProductCode();
    const result = await seedCreditConfig(db, productCode);
    trackSeedResult(result.configCreated);

    const riskRules = [
      "risk_identity_verified_v1",
      "risk_income_verifiable_v1",
      "risk_debt_to_income_v1",
      "risk_loan_history_v1",
      "risk_payment_history_v1",
      "risk_previous_delinquency_v1",
    ];

    for (const ruleId of riskRules) {
      const snap = await db.collection("risk_rules").doc(ruleId).get();
      expect(snap.exists).toBe(true);
      const rule = snap.data()!;
      expect(rule.name).toBeTruthy();
      expect(rule.kind).toBeTruthy();
      expect(rule.params).toBeTruthy();
      expect(rule.version).toBe(1);
      expect(rule.isActive).toBe(true);
      expect(rule.source).toBe("POLITICA_CREDITO_V1");
    }
  });

  it("verifica interest_rates creada", async () => {
    const productCode = uniqueProductCode();
    const result = await seedCreditConfig(db, productCode);
    trackSeedResult(result.configCreated);

    const rateSnap = await db.collection("interest_rates").doc(`${productCode}_v1`).get();
    expect(rateSnap.exists).toBe(true);
    const rate = rateSnap.data()!;
    expect(rate.productType).toBe(productCode);
    expect(rate.annualRateBps).toBe(0);
    expect(rate.source).toBe("PENDING_LEGAL_REVIEW");
    expect(rate.version).toBe(1);
    expect(rate.isActive).toBe(true);
  });
});