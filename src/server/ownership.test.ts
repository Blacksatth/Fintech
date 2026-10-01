import { describe, expect, it } from "vitest";
import { assertOwnedBy } from "./ownership";

function doc(userId: string) {
  return { id: "x", userId };
}

describe("assertOwnedBy", () => {
  it("devuelve el documento cuando es del usuario", () => {
    const propio = doc("uid-1");
    expect(assertOwnedBy(propio, "uid-1", "no encontrado")).toBe(propio);
  });

  it("lanza 404 si es de otro usuario", () => {
    expect(() => assertOwnedBy(doc("uid-2"), "uid-1", "no encontrado")).toThrow();
  });

  it("lanza 404 si no existe", () => {
    expect(() => assertOwnedBy(null, "uid-1", "no encontrado")).toThrow();
    expect(() => assertOwnedBy(undefined, "uid-1", "no encontrado")).toThrow();
  });

  it("el error es indistinguible entre 'no existe' y 'es de otro' (no filtra existencia)", () => {
    const ajeno = () => assertOwnedBy(doc("uid-2"), "uid-1", "Préstamo no encontrado");
    const inexistente = () => assertOwnedBy(null, "uid-1", "Préstamo no encontrado");

    const a = capturar(ajeno);
    const b = capturar(inexistente);

    expect(a.code).toBe("NOT_FOUND");
    expect(a.statusCode).toBe(404);
    expect(a.message).toBe(b.message);
    expect(a.name).toBe(b.name);
  });
});

function capturar(fn: () => unknown): { code?: string; statusCode?: number; message: string; name: string } {
  try {
    fn();
    throw new Error("assertOwnedBy debería lanzar");
  } catch (error) {
    const e = error as { code?: string; statusCode?: number; message: string; name: string };
    return { code: e.code, statusCode: e.statusCode, message: e.message, name: e.name };
  }
}
