import { describe, expect, it } from "vitest";
import {
  PASSWORD_MIN_LENGTH,
  authErrorMessage,
  credentialsSchema,
  profileSchema,
  registrationSchema,
  sessionExchangeSchema,
} from "./auth-input";

describe("sessionExchangeSchema", () => {
  it("acepta un idToken no vacío", () => {
    expect(sessionExchangeSchema.parse({ idToken: "abc.def.ghi" })).toEqual({ idToken: "abc.def.ghi" });
  });

  it("acepta nombre y teléfono opcionales para completar el perfil", () => {
    const parsed = sessionExchangeSchema.parse({
      idToken: "abc.def.ghi",
      fullName: "  Nueva Persona  ",
      phone: " +573001234567 ",
    });
    expect(parsed).toEqual({ idToken: "abc.def.ghi", fullName: "Nueva Persona", phone: "+573001234567" });
    expect(sessionExchangeSchema.parse({ idToken: "abc" })).toEqual({ idToken: "abc" });
  });

  it("rechaza cuerpo vacío, token ausente, token gigante y campos extra", () => {
    expect(() => sessionExchangeSchema.parse({})).toThrow();
    expect(() => sessionExchangeSchema.parse({ idToken: "" })).toThrow();
    expect(() => sessionExchangeSchema.parse({ idToken: "x".repeat(5000) })).toThrow();
    expect(() => sessionExchangeSchema.parse({ idToken: "abc", role: "ADMIN" })).toThrow();
  });

  it("rechaza perfil inválido en vez de descartarlo en silencio", () => {
    expect(() => sessionExchangeSchema.parse({ idToken: "abc", phone: "123" })).toThrow();
    expect(() => sessionExchangeSchema.parse({ idToken: "abc", fullName: "A" })).toThrow();
  });
});

describe("credentialsSchema", () => {
  it("normaliza el email (trim + minúsculas)", () => {
    expect(credentialsSchema.parse({ email: "  Persona@Local.DEV ", password: "clave-segura-1" })).toEqual({
      email: "persona@local.dev",
      password: "clave-segura-1",
    });
  });

  it("rechaza email inválido y contraseña corta", () => {
    expect(() => credentialsSchema.parse({ email: "no-es-email", password: "clave-segura-1" })).toThrow();
    expect(() => credentialsSchema.parse({ email: "a@b.co", password: "corta" })).toThrow();
  });

  it("exige la contraseña mínima de 8 caracteres", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(credentialsSchema.safeParse({ email: "a@b.co", password: "1234567" }).success).toBe(false);
    expect(credentialsSchema.safeParse({ email: "a@b.co", password: "1234567!" }).success).toBe(true);
  });

  it("exige al menos un carácter numérico", () => {
    const result = credentialsSchema.safeParse({ email: "a@b.co", password: "clave-segura!" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/número/i);
    expect(credentialsSchema.safeParse({ email: "a@b.co", password: "clave-segura1" }).success).toBe(true);
  });

  it("exige al menos un carácter especial", () => {
    const result = credentialsSchema.safeParse({ email: "a@b.co", password: "clavesegura1" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/especial/i);
    expect(credentialsSchema.safeParse({ email: "a@b.co", password: "clavesegura1!" }).success).toBe(true);
  });

  it("acepta símbolos comunes como carácter especial y valida el largo máximo", () => {
    for (const symbol of ["!", "@", "#", "$", "%", "&", "*", "-", "_", "+", "="]) {
      expect(credentialsSchema.safeParse({ email: "a@b.co", password: `ClaveSegura1${symbol}` }).success).toBe(
        true,
      );
    }
    expect(credentialsSchema.safeParse({ email: "a@b.co", password: `Clave1!${"a".repeat(5000)}` }).success).toBe(
      false,
    );
  });

  it("no filtra la contraseña en el mensaje de error", () => {
    const result = credentialsSchema.safeParse({ email: "a@b.co", password: "12345678" });
    expect(String(result.error?.issues)).not.toContain("12345678");
  });

  it("rechaza campos extra", () => {
    expect(() =>
      credentialsSchema.parse({ email: "a@b.co", password: "Clave1!", role: "ADMIN" }),
    ).toThrow();
  });
});

describe("registrationSchema", () => {
  it("pide email, contraseña, nombre y teléfono", () => {
    const input = {
      email: "nueva@local.dev",
      password: "clave-segura-1",
      fullName: "Nueva Persona",
      phone: "+573001234567",
    };
    expect(registrationSchema.parse(input)).toEqual(input);
  });

  it("rechaza nombre corto y teléfono Colombian inválido", () => {
    expect(() =>
      registrationSchema.parse({
        email: "nueva@local.dev",
        password: "clave-segura-1",
        fullName: "A",
        phone: "+573001234567",
      }),
    ).toThrow();
    expect(() =>
      registrationSchema.parse({
        email: "nueva@local.dev",
        password: "clave-segura-1",
        fullName: "Nueva Persona",
        phone: "123",
      }),
    ).toThrow();
  });
});

describe("profileSchema", () => {
  it("exige nombre y teléfono válidos sin pedir correo ni contraseña", () => {
    expect(profileSchema.parse({ fullName: "Nueva Persona", phone: "+573001234567" })).toEqual({
      fullName: "Nueva Persona",
      phone: "+573001234567",
    });
    expect(profileSchema.safeParse({ fullName: "Nueva Persona" }).success).toBe(false);
    expect(profileSchema.safeParse({ fullName: "Nueva Persona", phone: "123" }).success).toBe(false);
    expect(profileSchema.safeParse({ fullName: "Nueva Persona", phone: "+573001234567", role: "ADMIN" }).success).toBe(
      false,
    );
  });
});

describe("authErrorMessage", () => {
  it("traduce los códigos del Web SDK a español sin filtrar detalles técnicos", () => {
    expect(authErrorMessage("auth/invalid-credential")).toMatch(/correo o la contraseña/i);
    expect(authErrorMessage("auth/email-already-in-use")).toMatch(/ya existe una cuenta/i);
    expect(authErrorMessage("auth/too-many-requests")).toMatch(/demasiados intentos/i);
    expect(authErrorMessage("auth/invalid-email")).toMatch(/correo no es válido/i);
    expect(authErrorMessage("auth/weak-password")).toMatch(/débil/i);
    expect(authErrorMessage("auth/network-request-failed")).toMatch(/conexión/i);
    expect(authErrorMessage("auth/operation-not-allowed")).toMatch(/no está disponible/i);
  });

  it("traduce los errores de vinculación y de popup cancelado", () => {
    expect(authErrorMessage("auth/account-exists-with-different-credential")).toMatch(
      /ya tiene una cuenta con contraseña/i,
    );
    expect(authErrorMessage("auth/popup-closed-by-user")).toMatch(/cerraste/i);
    expect(authErrorMessage("auth/cancelled-popup-request")).toMatch(/cerraste/i);
  });

  it("cae en un mensaje genérico para códigos desconocidos", () => {
    expect(authErrorMessage("auth/lo-que-sea")).toBe("No pudimos completar la operación. Intenta de nuevo.");
    expect(authErrorMessage(undefined)).toBe("No pudimos completar la operación. Intenta de nuevo.");
  });
});
