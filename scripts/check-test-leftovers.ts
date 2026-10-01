import "dotenv/config";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) throw new Error("FIRESTE_PROJECT_ID / FIREBASE_PROJECT_ID requerida");
if (getApps().length === 0) initializeApp({ projectId });

const db = getFirestore();

const COLLECTIONS = [
  "users",
  "credit_profiles",
  "credit_scores",
  "loan_applications",
  "loans",
  "loan_installments",
  "disbursements",
  "payments",
  "payment_events",
  "payment_channels",
  "payment_proofs",
  "notifications",
  "audit_logs",
  "idempotency_keys",
  "credit_products",
  "product_tiers",
  "interest_rates",
  "system_config",
  "risk_rules",
] as const;

const TEST_PATTERNS = [
  /-TEST-/i,
  /-test-/i,
  /^MICRO_TEST_/i,
  /^uid-[0-9a-f]{8}$/i,
  /^integration-/i,
  /^ADMIN-TEST/i,
  /_test_/i,
];

function isTestish(id: string, data: Record<string, unknown>): boolean {
  const haystack = [
    id,
    data.applicationNumber,
    data.loanNumber,
    data.loanId,
    data.paymentNumber,
    data.paymentId,
    data.installmentId,
    data.email,
    data.productCode,
    data.productId,
    data.productType,
    data.reason,
    data.note,
  ]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return TEST_PATTERNS.some((p) => p.test(haystack));
}

async function main(): Promise<void> {
  let totalLeftovers = 0;

  // Un préstamo sin `loanNumber` es un documento esqueleto: la app los tolera (F9-2 los muestra
  // como "Sin datos"), pero en este proyecto nacen de tests que siembran `loans` con id automático
  // y se olvidan de borrarlos. Quedan huérfanos cuando el usuario de prueba sí se limpia.
  const uids = new Set((await db.collection("users").get()).docs.map((d) => d.id));
  const huerfanos = new Set<string>();
  {
    const snap = await db.collection("loans").get();
    for (const doc of snap.docs) {
      const data = doc.data() as { userId?: unknown; loanNumber?: unknown };
      if (data.loanNumber === undefined || !uids.has(String(data.userId))) huerfanos.add(doc.id);
    }
  }

  for (const collection of COLLECTIONS) {
    const snap = await db.collection(collection).get();
    const leftovers = snap.docs.filter(
      (d) => isTestish(d.id, d.data() as Record<string, unknown>) || huerfanos.has(d.id),
    );
    totalLeftovers += leftovers.length;
    const status = leftovers.length === 0 ? "limpio" : `LEFOVER x${leftovers.length}`;
    console.log(`${collection.padEnd(20)} total=${String(snap.size).padStart(4)}  ${status}`);
    for (const doc of leftovers.slice(0, 6)) {
      console.log(`   - ${doc.id}`);
    }
    if (leftovers.length > 6) console.log(`   ... +${leftovers.length - 6} mas`);
  }

  console.log(totalLeftovers === 0 ? "\nOK: 0 residuos de test" : `\nFALLO: ${totalLeftovers} residuos`);
  if (totalLeftovers > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
