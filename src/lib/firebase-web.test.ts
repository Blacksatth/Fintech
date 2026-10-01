import { describe, expect, it } from "vitest";
import { parseFirebaseWebConfig } from "./firebase-web";

const complete = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "AIzaKey",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "proyecto.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "proyecto",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "1234567890",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:1234567890:web:abc",
};

describe("parseFirebaseWebConfig", () => {
  it("acepta la configuración pública completa del Web SDK", () => {
    expect(parseFirebaseWebConfig(complete)).toEqual({
      apiKey: "AIzaKey",
      authDomain: "proyecto.firebaseapp.com",
      projectId: "proyecto",
      messagingSenderId: "1234567890",
      appId: "1:1234567890:web:abc",
    });
  });

  it("falla nombrando la variable ausente (apiKey y appId son las críticas)", () => {
    expect(() => parseFirebaseWebConfig({ ...complete, NEXT_PUBLIC_FIREBASE_API_KEY: "" })).toThrow(
      /NEXT_PUBLIC_FIREBASE_API_KEY/,
    );
    expect(() => parseFirebaseWebConfig({ ...complete, NEXT_PUBLIC_FIREBASE_APP_ID: undefined })).toThrow(
      /NEXT_PUBLIC_FIREBASE_APP_ID/,
    );
  });

  it("no acepta espacios en blanco como valor válido", () => {
    expect(() => parseFirebaseWebConfig({ ...complete, NEXT_PUBLIC_FIREBASE_PROJECT_ID: "   " })).toThrow(
      /NEXT_PUBLIC_FIREBASE_PROJECT_ID/,
    );
  });

  it("reporta todas las variables faltantes de una vez", () => {
    const message = (() => {
      try {
        parseFirebaseWebConfig({});
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
    })();

    expect(message).toContain("NEXT_PUBLIC_FIREBASE_API_KEY");
    expect(message).toContain("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN");
    expect(message).toContain("NEXT_PUBLIC_FIREBASE_APP_ID");
  });
});
