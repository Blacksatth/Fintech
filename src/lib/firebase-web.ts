import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { z } from "zod";

const webEnvSchema = z.object({
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().trim().min(1, "falta la API key del Web SDK"),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().trim().min(1, "falta el auth domain"),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().trim().min(1, "falta el project id"),
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: z.string().trim().min(1, "falta el sender id"),
  NEXT_PUBLIC_FIREBASE_APP_ID: z.string().trim().min(1, "falta el app id"),
});

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
}

export function parseFirebaseWebConfig(source: Record<string, string | undefined>): FirebaseWebConfig {
  const parsed = webEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuracion del Web SDK de Firebase incompleta: ${issues}`);
  }
  const env = parsed.data;
  return {
    apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
}

let cachedAuth: Auth | null = null;

export function getFirebaseWebAuth(): Auth {
  if (typeof window === "undefined") {
    throw new Error("getFirebaseWebAuth solo se puede usar en el navegador");
  }
  if (cachedAuth) return cachedAuth;

  const config = parseFirebaseWebConfig({
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  });

  cachedAuth = getAuth(getApps().length > 0 ? getApp() : initializeApp(config));
  return cachedAuth;
}
