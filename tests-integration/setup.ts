import "dotenv/config";
import { getApps, initializeApp } from "firebase-admin/app";

if (!process.env.FIREBASE_PROJECT_ID) {
  throw new Error(
    "FIREBASE_PROJECT_ID requerida para tests de integracion. Revisa .env (GOOGLE_APPLICATION_CREDENTIALS incluida).",
  );
}

if (getApps().length === 0) {
  initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
}