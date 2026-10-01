import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, describe, expect, it } from "vitest";
import { seedDevAdmin } from "../src/services/users/seed-dev-admin";

/**
 * Integración REAL contra el proyecto del `.env` (D3: sin emuladores).
 * Usa un email aleatorio por ejecución: no toca el admin del seed y se limpia
 * al terminar (Auth + Firestore), así el test es repetible.
 */

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID requerida para el test de integración. Revisa .env");
}
if (getApps().length === 0) {
  initializeApp({ projectId });
}

const db = getFirestore();
const auth = getAuth();

const createdEmails: string[] = [];
const createdUids: string[] = [];

/**
 * Limpia SIEMPRE Firestore (users + user_profiles) y Auth. Un fallo de limpieza
 * se reporta: dejar basura en el proyecto real es peor que un test rojo.
 */
async function cleanup() {
  const failures: string[] = [];

  for (const uid of createdUids) {
    await db.doc(`users/${uid}`).delete().catch((err: Error) => failures.push(`users/${uid}: ${err.message}`));
    await db
      .doc(`user_profiles/${uid}`)
      .delete()
      .catch((err: Error) => failures.push(`user_profiles/${uid}: ${err.message}`));
    await auth.deleteUser(uid).catch((err: Error) => failures.push(`auth/${uid}: ${err.message}`));
  }

  for (const email of createdEmails) {
    const user = await auth.getUserByEmail(email).catch(() => null);
    if (!user) continue;
    await db
      .collection("users")
      .where("email", "==", email)
      .get()
      .then((snap) => Promise.all(snap.docs.map((d) => d.ref.delete())))
      .catch((err: Error) => failures.push(`users by email ${email}: ${err.message}`));
    await auth.deleteUser(user.uid).catch((err: Error) => failures.push(`auth/${email}: ${err.message}`));
  }

  if (failures.length > 0) {
    throw new Error(`limpieza incompleta: ${failures.join("; ")}`);
  }
}

function uniqueEmail(prefix: string): string {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@local.dev`;
  createdEmails.push(email);
  return email;
}

const PASSWORD = "seed-test-password-2026";

async function seedInput(prefix: string) {
  const email = uniqueEmail(prefix);
  const result = await seedDevAdmin(db, auth, {
    email,
    password: PASSWORD,
    fullName: "Admin Dev Test",
    phone: "+573001234567",
  });
  createdUids.push(result.uid);
  return { email, result };
}

afterAll(cleanup);

describe("seedDevAdmin contra Firestore/Auth reales", () => {
  it("crea el usuario en Auth y los documentos users y user_profiles con rol ADMIN", async () => {
    const { email, result } = await seedInput("admin");

    expect(result.createdInAuth).toBe(true);
    expect(result.createdInFirestore).toBe(true);
    expect(result.uid).toBeTruthy();

    const authUser = await auth.getUser(result.uid);
    expect(authUser.email).toBe(email);
    expect(authUser.disabled).toBe(false);

    const userSnap = await db.collection("users").doc(result.uid).get();
    expect(userSnap.exists).toBe(true);
    expect(userSnap.get("role")).toBe("ADMIN");
    expect(userSnap.get("status")).toBe("ACTIVE");
    expect(userSnap.get("email")).toBe(email);

    const createdAt = userSnap.get("createdAt") as { toMillis: () => number };
    const updatedAt = userSnap.get("updatedAt") as { toMillis: () => number };
    expect(typeof createdAt.toMillis).toBe("function");
    expect(createdAt.toMillis()).toBe(updatedAt.toMillis());
    expect(createdAt.toMillis()).toBeLessThanOrEqual(Date.now());

    const profileSnap = await db.collection("user_profiles").doc(result.uid).get();
    expect(profileSnap.exists).toBe(true);
    const profileUpdatedAt = profileSnap.get("updatedAt") as { toMillis: () => number };
    expect(typeof profileUpdatedAt.toMillis).toBe("function");
  });

  it("es idempotente: repetir el seed reutiliza el mismo uid y no duplica nada", async () => {
    const email = uniqueEmail("admin-idem");
    const first = await seedDevAdmin(db, auth, {
      email,
      password: PASSWORD,
      fullName: "Admin Dev Test",
      phone: "+573001234567",
    });
    createdUids.push(first.uid);

    const second = await seedDevAdmin(db, auth, {
      email,
      password: PASSWORD,
      fullName: "Admin Dev Test",
      phone: "+573001234567",
    });

    expect(second.uid).toBe(first.uid);
    expect(second.createdInAuth).toBe(false);
    expect(second.createdInFirestore).toBe(false);

    const usersSnap = await db.collection("users").where("email", "==", email).get();
    expect(usersSnap.size).toBe(1);

    const profilesSnap = await db.collection("user_profiles").where("updatedAt", ">", new Date(0)).get();
    expect(profilesSnap.docs.some((d) => d.id === first.uid)).toBe(true);
  });

  it("rechaza una contraseña débil antes de tocar Auth o Firestore", async () => {
    const email = uniqueEmail("admin-weak");

    await expect(
      seedDevAdmin(db, auth, {
        email,
        password: "corta",
        fullName: "Admin Dev Test",
        phone: "+573001234567",
      }),
    ).rejects.toThrow(/demasiado corta|SEED_ADMIN_PASSWORD/);

    expect(await auth.getUserByEmail(email).catch(() => null)).toBeNull();
    const usersSnap = await db.collection("users").where("email", "==", email).get();
    expect(usersSnap.empty).toBe(true);
  });
});
