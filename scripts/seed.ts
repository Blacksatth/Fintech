import "dotenv/config";
import { seedDevAdmin } from "../src/services/users/seed-dev-admin";
import { seedCreditConfig } from "../src/services/credit/seed-credit-config";
import { seedPaymentChannels } from "../src/services/payments/seed-payment-channels";

/**
 * Seed del administrador de DESARROLLO (F4-1), configuración de crédito (F5-1) y
 * canales de pago (F10-1).
 *
 * Crea/garantiza `users/{uid}` y `user_profiles/{uid}` con rol ADMIN en el
 * proyecto del `.env` (D3: conexión directa al proyecto real, sin emuladores)
 * y su usuario equivalente en Firebase Auth.
 *
 * También crea la configuración de crédito: productos, tiers, reglas de riesgo,
 * tasas de interés y configuración del sistema.
 *
 * La contraseña NUNCA está en el código: llega por `SEED_ADMIN_PASSWORD` en
 * `.env` y no se imprime en los logs. Reejecutar es seguro (idempotente).
 *
 * Uso: npm run seed
 */

const projectId = process.env.FIREBASE_PROJECT_ID;

if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID no está definida. Revisa .env");
}

const email = process.env.SEED_ADMIN_EMAIL ?? "admin@local.dev";
const fullName = process.env.SEED_ADMIN_FULL_NAME ?? "Administrador Dev";
const phone = process.env.SEED_ADMIN_PHONE ?? "+573001234567";

async function main() {
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      "SEED_ADMIN_PASSWORD no está definida. Define una contraseña de desarrollo (mínimo 12 caracteres) en .env; nunca en el código.",
    );
  }

  const { initializeApp, getApps } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  const { getFirestore } = await import("firebase-admin/firestore");

  if (getApps().length === 0) {
    initializeApp({ projectId });
  }
  const auth = getAuth();
  const db = getFirestore();

  console.log(`[seed] proyecto ${projectId} · admin ${email}`);
  const adminResult = await seedDevAdmin(db, auth, { email, password, fullName, phone });

  console.log(`[seed] uid: ${adminResult.uid}`);
  console.log(
    `[seed] Auth: ${adminResult.createdInAuth ? "creado" : "ya existía (contraseña actualizada)"} · ` +
      `Firestore: ${adminResult.createdInFirestore ? "users + user_profiles creados" : "documentos ya existían, intactos"}`,
  );

  console.log("[seed] sembrando configuración de crédito...");
  const creditResult = await seedCreditConfig(db);
  console.log(`[seed] producto: ${creditResult.productCode}`);
  console.log(`[seed] tiers creados: ${creditResult.tiersCreated}`);
  console.log(`[seed] configs creadas: ${creditResult.configCreated.length}`);
  if (creditResult.configCreated.length > 0) {
    for (const c of creditResult.configCreated) {
      console.log(`[seed]   - ${c}`);
    }
  }

  console.log("[seed] sembrando canales de pago (texto demo, sin APIs)...");
  const channelsResult = await seedPaymentChannels(db);
  console.log(`[seed] canales creados: ${channelsResult.channelsCreated}`);
  for (const channel of channelsResult.channels) {
    console.log(`[seed]   - ${channel}`);
  }
  if (channelsResult.channelsCreated > 0) {
    console.log("[seed] los canales quedan marcados como DEMO: reemplaza cuentas e instrucciones antes de producción");
  }

  console.log("[seed] OK: administrador de desarrollo con rol ADMIN + configuración de crédito + canales de pago");
}
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[seed] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
