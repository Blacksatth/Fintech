import { type Firestore } from "firebase-admin/firestore";
import { stripUndefined } from "@/server/doc";
import {
  buildCreditProductDoc,
  buildProductTierDoc,
  buildSystemConfigDoc,
  buildRiskRuleDoc,
  buildInterestRateDoc,
  Currency,
  TermFrequency,
} from "@/server/credit-doc";

export interface SeedCreditConfigResult {
  productCode: string;
  tiersCreated: number;
  configCreated: string[];
}

const DEFAULT_PRODUCT_CODE = "MICRO_BASICO";

function buildDemoConfig(_productCode: string) {
  return { tiers: TIER_DEFAULTS };
}

const TIER_DEFAULTS = [
  { position: 1, amountPesos: 50000, minScore: 60 },
  { position: 2, amountPesos: 75000, minScore: 65 },
  { position: 3, amountPesos: 100000, minScore: 70 },
] as const;

/**
 * Terminos del producto demo (regla de plazo F8): pago MENSUAL y el cliente elige entre
 * 2 y 6 cuotas. `termInstallments` es solo el default que ofrece el formulario.
 */
const DEFAULT_PRODUCT = {
  name: "Microcrédito Básico",
  currency: Currency.COP,
  termInstallments: 4,
  termFrequency: TermFrequency.MONTHLY,
  minTermInstallments: 2,
  maxTermInstallments: 6,
  effectiveFeeBps: 0,
  isActive: true,
} as const;

const SYSTEM_CONFIG_DEFAULTS = {
  delinquency: {
    dueSoonDays: 3,
    overdueDays: 1,
    defaultDays: 30,
  },
  scoring: {
    minScoreForTier1: 60,
    minScoreForTier2: 65,
    minScoreForTier3: 70,
  },
  session: {
    maxAgeDays: 5,
  },
  loan: {
    maxActiveLoansPerUser: 1,
  },
};

const RISK_RULES_DEMO = [
  {
    name: "Identidad verificada",
    kind: "IDENTITY_VERIFIED",
    params: { weightBps: 1500 },
    version: 1,
    source: "POLITICA_CREDITO_V1",
  },
  {
    name: "Ingresos verificables",
    kind: "INCOME_VERIFIABLE",
    params: { weightBps: 2000 },
    version: 1,
    source: "POLITICA_CREDITO_V1",
  },
  {
    name: "Capacidad de pago",
    kind: "DEBT_TO_INCOME",
    params: { maxRatio: 0.4, weightBps: 2500 },
    version: 1,
    source: "POLITICA_CREDITO_V1",
  },
  {
    name: "Historial de préstamos",
    kind: "LOAN_HISTORY",
    params: { weightBps: 1500 },
    version: 1,
    source: "POLITICA_CREDITO_V1",
  },
  {
    name: "Historial de pagos",
    kind: "PAYMENT_HISTORY",
    params: { weightBps: 1500 },
    version: 1,
    source: "POLITICA_CREDITO_V1",
  },
  {
    name: "Moras previas",
    kind: "PREVIOUS_DELINQUENCY",
    params: { weightBps: 1000 },
    version: 1,
    source: "POLITICA_CREDITO_V1",
  },
] as const;

async function docExists(db: Firestore, collection: string, id: string): Promise<boolean> {
  const snap = await db.collection(collection).doc(id).get();
  return snap.exists;
}

export async function seedCreditConfig(db: Firestore, productCode?: string): Promise<SeedCreditConfigResult> {
  const now = new Date();
  let tiersCreated = 0;
  const configCreated: string[] = [];
  const code = productCode ?? DEFAULT_PRODUCT_CODE;
  const { tiers } = buildDemoConfig(code);

  const productRef = db.collection("credit_products").doc(code);
  const productSnap = await productRef.get();
  if (!productSnap.exists) {
    const productDoc = buildCreditProductDoc(
      {
        name: DEFAULT_PRODUCT.name,
        currency: DEFAULT_PRODUCT.currency,
        termInstallments: DEFAULT_PRODUCT.termInstallments,
        termFrequency: DEFAULT_PRODUCT.termFrequency,
        minTermInstallments: DEFAULT_PRODUCT.minTermInstallments,
        maxTermInstallments: DEFAULT_PRODUCT.maxTermInstallments,
        effectiveFeeBps: DEFAULT_PRODUCT.effectiveFeeBps,
        isActive: DEFAULT_PRODUCT.isActive,
      },
      now,
    );
    await productRef.set(stripUndefined(productDoc));
    configCreated.push(`credit_products/${code}`);
  } else {
    // Upgrade aditivo de docs legados (sembrados antes de la regla de plazo): si el producto
    // no declara rango de cuotas, se migra a mensual 2-6. No pisa un producto configurado
    // de otra forma mientras ya tenga el rango.
    const data = productSnap.data() as { minTermInstallments?: number; maxTermInstallments?: number };
    if (data.minTermInstallments === undefined || data.maxTermInstallments === undefined) {
      await productRef.update(
        stripUndefined({
          termInstallments: DEFAULT_PRODUCT.termInstallments,
          termFrequency: DEFAULT_PRODUCT.termFrequency,
          minTermInstallments: DEFAULT_PRODUCT.minTermInstallments,
          maxTermInstallments: DEFAULT_PRODUCT.maxTermInstallments,
          updatedAt: now,
        }),
      );
      configCreated.push(`credit_products/${code} (upgrade)`);
    }
  }

  for (const tier of tiers) {
    const tierId = `${code}_${tier.position}`;
    if (!(await docExists(db, "product_tiers", tierId))) {
      const tierDoc = buildProductTierDoc(
        {
          productCode: code,
          position: tier.position,
          amountPesos: tier.amountPesos,
          minScore: tier.minScore,
          isActive: true,
        },
        now,
      );
      await db.collection("product_tiers").doc(tierId).set(stripUndefined(tierDoc));
      tiersCreated++;
      configCreated.push(`product_tiers/${tierId}`);
    }
  }

  if (!(await docExists(db, "system_config", "delinquency"))) {
    await db
      .collection("system_config")
      .doc("delinquency")
      .set(stripUndefined(buildSystemConfigDoc({ value: SYSTEM_CONFIG_DEFAULTS.delinquency, updatedBy: "SEED" }, now)));
    configCreated.push("system_config/delinquency");
  }

  if (!(await docExists(db, "system_config", "scoring"))) {
    await db
      .collection("system_config")
      .doc("scoring")
      .set(stripUndefined(buildSystemConfigDoc({ value: SYSTEM_CONFIG_DEFAULTS.scoring, updatedBy: "SEED" }, now)));
    configCreated.push("system_config/scoring");
  }

  if (!(await docExists(db, "system_config", "session"))) {
    await db
      .collection("system_config")
      .doc("session")
      .set(stripUndefined(buildSystemConfigDoc({ value: SYSTEM_CONFIG_DEFAULTS.session, updatedBy: "SEED" }, now)));
    configCreated.push("system_config/session");
  }

  if (!(await docExists(db, "system_config", "loan"))) {
    await db
      .collection("system_config")
      .doc("loan")
      .set(stripUndefined(buildSystemConfigDoc({ value: SYSTEM_CONFIG_DEFAULTS.loan, updatedBy: "SEED" }, now)));
    configCreated.push("system_config/loan");
  }

  for (let i = 0; i < RISK_RULES_DEMO.length; i++) {
    const rule = RISK_RULES_DEMO[i];
    const ruleId = `risk_${rule.kind.toLowerCase()}_v${rule.version}`;
    if (!(await docExists(db, "risk_rules", ruleId))) {
      const ruleDoc = buildRiskRuleDoc(
        {
          name: rule.name,
          kind: rule.kind,
          params: rule.params,
          version: rule.version,
          isActive: true,
          source: rule.source,
        },
        now,
      );
      await db.collection("risk_rules").doc(ruleId).set(stripUndefined(ruleDoc));
      configCreated.push(`risk_rules/${ruleId}`);
    }
  }

  const interestRateId = `${code}_v1`;
  if (!(await docExists(db, "interest_rates", interestRateId))) {
    const rateDoc = buildInterestRateDoc(
      {
        productType: code,
        annualRateBps: 0,
        effectiveFrom: new Date("2026-01-01"),
        source: "PENDING_LEGAL_REVIEW",
        version: 1,
      },
      now,
    );
    await db.collection("interest_rates").doc(interestRateId).set(stripUndefined(rateDoc));
    configCreated.push(`interest_rates/${interestRateId}`);
  }

  return { productCode: code, tiersCreated, configCreated };
}