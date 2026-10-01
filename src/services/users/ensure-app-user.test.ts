import { describe, expect, it } from "vitest";
import { planAppUser } from "./ensure-app-user";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const identity = { email: "Nueva@Local.DEV", emailVerified: true };
const profile = { fullName: "Nueva Persona", phone: "+573001234567" };

describe("planAppUser", () => {
  it("crea ambos documentos para un usuario nuevo con perfil completo", () => {
    const plan = planAppUser({ identity, profile, userExists: false, now: NOW });

    expect(plan.create).toBe(true);
    expect(plan.profileComplete).toBe(true);
    expect(plan.userDoc).toEqual({
      email: "nueva@local.dev",
      fullName: "Nueva Persona",
      phone: "+573001234567",
      role: "CUSTOMER",
      status: "ACTIVE",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(plan.profileDoc).toEqual({ updatedAt: NOW });
  });

  it("guarda exactamente los campos del §8.1 (ni contraseña ni datos del proveedor)", () => {
    const plan = planAppUser({ identity, profile, userExists: false, now: NOW });

    expect(Object.keys(plan.userDoc ?? {}).sort()).toEqual([
      "createdAt",
      "email",
      "fullName",
      "phone",
      "role",
      "status",
      "updatedAt",
    ]);
    expect(plan.userDoc).not.toHaveProperty("password");
    expect(plan.userDoc).not.toHaveProperty("photoURL");
    expect(plan.userDoc).not.toHaveProperty("emailVerified");
  });

  it("no planifica escrituras si el usuario ya existe (nunca pisa rol ni estado)", () => {
    const plan = planAppUser({ identity, profile, userExists: true, now: NOW });

    expect(plan).toEqual({ create: false, profileComplete: true, userDoc: undefined, profileDoc: undefined });
  });

  it("exige nombre y teléfono antes de crear el usuario", () => {
    const sinNombre = planAppUser({ identity, profile: { phone: "+573001234567" }, userExists: false, now: NOW });
    const sinTelefono = planAppUser({ identity, profile: { fullName: "Nueva Persona" }, userExists: false, now: NOW });

    expect(sinNombre.profileComplete).toBe(false);
    expect(sinNombre.create).toBe(false);
    expect(sinTelefono.profileComplete).toBe(false);
    expect(sinTelefono.create).toBe(false);
  });

  it("rechaza un perfil con formato inválido en vez de normalizarlo a medias", () => {
    expect(() =>
      planAppUser({ identity, profile: { fullName: "Nueva Persona", phone: "123" }, userExists: false, now: NOW }),
    ).toThrow();
    expect(() =>
      planAppUser({ identity, profile: { fullName: "A", phone: "+573001234567" }, userExists: false, now: NOW }),
    ).toThrow();
  });

  it("no valida el perfil de un usuario que ya existe (no se va a escribir)", () => {
    const plan = planAppUser({ identity, profile: { phone: "no-es-telefono" }, userExists: true, now: NOW });

    expect(plan.create).toBe(false);
    expect(plan.profileComplete).toBe(true);
  });
});
