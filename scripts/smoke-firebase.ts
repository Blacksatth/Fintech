import "dotenv/config";

const projectId = process.env.FIREBASE_PROJECT_ID;

if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID no está definida. Revisa .env");
}

/**
 * Smoke test de la conexion real (F3-2, sin emuladores).
 * Escribe un documento efimero en Firestore, lo lee y lo borra.
 * Uso: npm run smoke
 */
async function main() {
  const { initializeApp, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");

  if (getApps().length === 0) {
    initializeApp({ projectId });
  }
  const db = getFirestore();
  console.log(`[smoke] Firestore directo al proyecto ${projectId}`);

  const doc = db.collection("_smoke").doc(`test-${Date.now()}`);
  await doc.set({ ok: true, at: new Date(), note: "F3-2 smoke test" });
  const snap = await doc.get();
  const data = snap.data();

  if (!snap.exists || data?.ok !== true) {
    throw new Error("smoke FAILED: no se pudo leer el documento escrito");
  }
  await doc.delete();
  console.log("[smoke] OK: write+read+delete en Firestore real");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[smoke] FAILED:", err);
    process.exit(1);
  });