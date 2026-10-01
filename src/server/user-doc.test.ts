import { describe, expect, it } from "vitest";
import {
  assertSeedPasswordIsStrong,
  buildUserDoc,
  buildUserProfileDoc,
  isAdminUser,
  SEED_PASSWORD_MIN_LENGTH,
  userDocSchema,
  userProfileDocSchema,
} from "./user-doc";

const now = new Date("2026-09-25T12:00:00.000Z");

describe("buildUserDoc", () => {
  it("crea un CUSTOMER activo por defecto con email normalizado y los mismos timestamps", () => {
    const user = buildUserDoc(
      { email: "  Cliente@Ejemplo.COM ", fullName: "Ana Pérez", phone: "+573001234567" },
      now,
    );

    expect(user.email).toBe("cliente@ejemplo.com");
    expect(user.role).toBe("CUSTOMER");
    expect(user.status).toBe("ACTIVE");
    expect(user.createdAt).toEqual(now);
    expect(user.updatedAt).toEqual(now);
  });

  it("rechaza un email que no es una dirección válida", () => {
    expect(() =>
      buildUserDoc({ email: "no-es-un-email", fullName: "Ana", phone: "3001234567" }, now),
    ).toThrow();
  });

  it("rechaza un teléfono vacío o con letras", () => {
    expect(() =>
      buildUserDoc({ email: "ana@ejemplo.com", fullName: "Ana", phone: "  " }, now),
    ).toThrow();
    expect(() =>
      buildUserDoc({ email: "ana@ejemplo.com", fullName: "Ana", phone: "llamar" }, now),
    ).toThrow();
  });

  it("rechaza un nombre vacío o con longitud excesiva", () => {
    expect(() =>
      buildUserDoc({ email: "ana@ejemplo.com", fullName: "   ", phone: "3001234567" }, now),
    ).toThrow();
    expect(() =>
      buildUserDoc({ email: "ana@ejemplo.com", fullName: "a".repeat(121), phone: "3001234567" }, now),
    ).toThrow();
  });

  it("permite fijar el rol ADMIN de forma explícita", () => {
    const admin = buildUserDoc(
      { email: "admin@local.dev", fullName: "Admin Dev", phone: "3001234567", role: "ADMIN" },
      now,
    );

    expect(admin.role).toBe("ADMIN");
    expect(isAdminUser(admin)).toBe(true);
  });
});

describe("userDocSchema", () => {
  it("rechaza un rol fuera del enum", () => {
    const result = userDocSchema.safeParse({
      email: "ana@ejemplo.com",
      fullName: "Ana",
      phone: "3001234567",
      role: "SUPERADMIN",
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });

    expect(result.success).toBe(false);
  });

  it("rechaza campos extra: el documento no guarda datos no previstos", () => {
    const result = userDocSchema.safeParse({
      email: "ana@ejemplo.com",
      fullName: "Ana",
      phone: "3001234567",
      role: "CUSTOMER",
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
      passwordHash: "nunca-aqui",
    });

    expect(result.success).toBe(false);
  });

  it("acepta el documento producido por buildUserDoc", () => {
    const user = buildUserDoc(
      { email: "ana@ejemplo.com", fullName: "Ana", phone: "3001234567" },
      now,
    );

    expect(userDocSchema.safeParse(user).success).toBe(true);
  });
});

describe("buildUserProfileDoc", () => {
  it("omite los campos opcionales en vez de guardar null o cadena vacía", () => {
    const profile = buildUserProfileDoc({}, now);

    expect(profile).toEqual({ updatedAt: now });
    expect("city" in profile).toBe(false);
    expect("occupation" in profile).toBe(false);
  });

  it("descarta cadenas vacías en vez de persistirlas", () => {
    const profile = buildUserProfileDoc({ city: "  ", occupation: "Comerciante" }, now);

    expect("city" in profile).toBe(false);
    expect(profile.occupation).toBe("Comerciante");
  });

  it("rechaza un rango de ingresos que no corresponde a las bandas permitidas", () => {
    expect(() => buildUserProfileDoc({ monthlyIncomeRange: "millones" }, now)).toThrow();
  });

  it("acepta el documento producido por buildUserProfileDoc con banda válida", () => {
    const profile = buildUserProfileDoc(
      { city: "Bogotá", occupation: "Comerciante", monthlyIncomeRange: "2M-4M" },
      now,
    );

    expect(userProfileDocSchema.safeParse(profile).success).toBe(true);
  });
});

describe("isAdminUser", () => {
  it("es falso si el rol no es ADMIN aunque el documento sea válido", () => {
    const customer = buildUserDoc(
      { email: "ana@ejemplo.com", fullName: "Ana", phone: "3001234567" },
      now,
    );

    expect(isAdminUser(customer)).toBe(false);
  });

  it("es falso para un ADMIN suspendido: el estado se respeta", () => {
    const suspended = { ...buildUserDoc(
      { email: "admin@local.dev", fullName: "Admin", phone: "3001234567", role: "ADMIN" },
      now,
    ), status: "SUSPENDED" as const };

    expect(isAdminUser(suspended)).toBe(false);
  });
});

describe("assertSeedPasswordIsStrong", () => {
  it("rechaza una contraseña más corta que el mínimo exigido", () => {
    expect(() => assertSeedPasswordIsStrong("a".repeat(SEED_PASSWORD_MIN_LENGTH - 1))).toThrow();
  });

  it("rechaza una contraseña vacía o con espacios solamente", () => {
    expect(() => assertSeedPasswordIsStrong("")).toThrow();
    expect(() => assertSeedPasswordIsStrong("        ")).toThrow();
  });

  it("acepta una contraseña que cumple el mínimo y no es trivial", () => {
    expect(() => assertSeedPasswordIsStrong("local-dev-admin-2026")).not.toThrow();
  });
});
