import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

describe("env (validacion Zod del .env)", () => {
  it("acepta un entorno valido", () => {
    const env = parseEnv({ FIREBASE_PROJECT_ID: "credito-a1b4a" });
    expect(env.FIREBASE_PROJECT_ID).toBe("credito-a1b4a");
  });

  it("acepta GOOGLE_APPLICATION_CREDENTIALS opcional", () => {
    const env = parseEnv({
      FIREBASE_PROJECT_ID: "credito-a1b4a",
      GOOGLE_APPLICATION_CREDENTIALS: "./sa.json",
    });
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("./sa.json");
  });

  it("rechaza sin FIREBASE_PROJECT_ID", () => {
    expect(() => parseEnv({})).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it("rechaza FIREBASE_PROJECT_ID vacia", () => {
    expect(() => parseEnv({ FIREBASE_PROJECT_ID: "" })).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it("ignora variables irrelevantes", () => {
    const env = parseEnv({ FIREBASE_PROJECT_ID: "x", NEXT_PUBLIC_FIREBASE_API_KEY: "k" });
    expect(env.FIREBASE_PROJECT_ID).toBe("x");
  });

  it("una variable opcional en blanco cuenta como ausente, no como entorno invalido", () => {
    // Es la forma en que un `.env` real deja Cloudinary pendiente de completar, y no puede
    // tirar el proceso entero: el comprobante de pago es opcional en el flujo de pagos.
    const env = parseEnv({
      FIREBASE_PROJECT_ID: "credito-a1b4a",
      CLOUDINARY_CLOUD_NAME: "",
      CLOUDINARY_API_KEY: "   ",
      CLOUDINARY_API_SECRET: "",
      GOOGLE_APPLICATION_CREDENTIALS: "",
    });
    expect(env.CLOUDINARY_CLOUD_NAME).toBeUndefined();
    expect(env.CLOUDINARY_API_KEY).toBeUndefined();
    expect(env.CLOUDINARY_API_SECRET).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.FIREBASE_PROJECT_ID).toBe("credito-a1b4a");
  });

  it("una variable opcional con valor se respeta", () => {
    const env = parseEnv({
      FIREBASE_PROJECT_ID: "credito-a1b4a",
      CLOUDINARY_CLOUD_NAME: "mi-nube",
    });
    expect(env.CLOUDINARY_CLOUD_NAME).toBe("mi-nube");
  });
});