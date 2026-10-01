import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage, type Storage } from "firebase-admin/storage";
import "server-only";

const projectId = process.env.FIREBASE_PROJECT_ID;

/**
 * App de Firebase Admin (solo servidor). Dev/emuladores: sin credenciales, el
 * SDK se enruta a los emuladores por las variables FIRESTORE_EMULATOR_HOST /
 * FIREBASE_AUTH_EMULATOR_HOST / FIREBASE_STORAGE_EMULATOR_HOST.
 * Produccion: GOOGLE_APPLICATION_CREDENTIALS o service account via env.
 */
export function getAdminApp(): App {
  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID no está definida");
  }
  const existing = getApps()[0];
  if (existing) return existing;

  const hasServiceAccount =
    process.env.FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL &&
    process.env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY;

  return initializeApp({
    projectId,
    ...(hasServiceAccount
      ? {
          credential: cert({
            projectId,
            clientEmail: process.env.FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL!,
            privateKey: process.env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY!.replace(/\\n/g, "\n"),
          }),
        }
      : {}),
  });
}

export function getDb(): Firestore {
  return getFirestore(getAdminApp());
}

export function getAuthAdmin(): Auth {
  return getAuth(getAdminApp());
}

export function getStorageAdmin(): Storage {
  return getStorage(getAdminApp());
}