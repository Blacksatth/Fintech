import { describe, expect, it } from "vitest";
import { add, assertSafeInteger, div, divMod, formatPesos, formatPesosOrDash, mul, roundDiv, sub } from "./money";

describe("money (pesos enteros COP)", () => {
  it("suma exacta sin perder pesos", () => {
    expect(add(50000, 75000)).toBe(125000);
  });

  it("suma no acepta decimales", () => {
    expect(() => add(50000, 0.5)).toThrow(RangeError);
  });

  it("resta exacta", () => {
    expect(sub(125000, 75000)).toBe(50000);
  });

  it("resta rechaza desbordar el rango seguro", () => {
    expect(() => sub(Number.MAX_SAFE_INTEGER, -1)).toThrow(RangeError);
  });

  it("multiplicacion exacta", () => {
    expect(mul(3, 50000)).toBe(150000);
  });

  it("multiplicacion rechaza overflow", () => {
    expect(() => mul(2 ** 30, 2 ** 30)).toThrow(RangeError);
  });

  it("division entera (truncada hacia abajo)", () => {
    expect(div(100050, 4)).toBe(25012);
  });

  it("division rechaza divisor no positivo o no entero", () => {
    expect(() => div(100, 0)).toThrow(RangeError);
    expect(() => div(100, 2.5)).toThrow(RangeError);
  });

  it("divMod devuelve cociente y residuo enteros", () => {
    expect(divMod(100050, 4)).toEqual({ quotient: 25012, remainder: 2 });
  });

  it("formatPesos formatea es-CO sin centimos", () => {
    expect(formatPesos(50000)).toMatch(/50\.000/);
  });

  it("assertSafeInteger rechaza no-enteros y fuera de rango", () => {
    expect(() => assertSafeInteger(50000.5)).toThrow(RangeError);
    expect(() => assertSafeInteger(2 ** 53 + 1)).toThrow(RangeError);
  });

  describe("formatPesosOrDash (documentos legacy sin importes)", () => {
    it("formatea los enteros seguros como siempre", () => {
      expect(formatPesosOrDash(50000)).toMatch(/50\.000/);
      expect(formatPesosOrDash(0)).toMatch(/0/);
    });

    it("devuelve guion largo cuando el importe no existe o no es un entero seguro", () => {
      expect(formatPesosOrDash(undefined)).toBe("—");
      expect(formatPesosOrDash(null)).toBe("—");
      expect(formatPesosOrDash(50000.5)).toBe("—");
      expect(formatPesosOrDash(2 ** 53 + 1)).toBe("—");
      expect(formatPesosOrDash("50000")).toBe("—");
      expect(formatPesosOrDash({ amount: 1 })).toBe("—");
    });

    it("no relaja la invariante: formatPesos sigue lanzando con datos invalidos", () => {
      expect(() => formatPesos(undefined as unknown as number)).toThrow(RangeError);
    });
  });
});

describe("money (roundDiv para aritmetica de basis points)", () => {
  it("redondea al entero mas cercano", () => {
    expect(roundDiv(10, 4)).toBe(3);
    expect(roundDiv(11, 4)).toBe(3);
    expect(roundDiv(12, 4)).toBe(3);
    expect(roundDiv(13, 4)).toBe(3);
  });

  it("redondea .5 hacia arriba", () => {
    expect(roundDiv(1, 2)).toBe(1);
    expect(roundDiv(3, 2)).toBe(2);
    expect(roundDiv(5, 2)).toBe(3);
  });

  it("devuelve entero exacto cuando no hay residuo", () => {
    expect(roundDiv(240000000, 120000)).toBe(2000);
  });

  it("redondea hacia arriba en negativo (media away from zero)", () => {
    expect(roundDiv(-1, 2)).toBe(-1);
    expect(roundDiv(-5, 2)).toBe(-3);
  });

  it("cero se mantiene cero", () => {
    expect(roundDiv(0, 7)).toBe(0);
  });

  it("rechaza divisor no positivo o no entero", () => {
    expect(() => roundDiv(10, 0)).toThrow(RangeError);
    expect(() => roundDiv(10, -2)).toThrow(RangeError);
    expect(() => roundDiv(10, 2.5)).toThrow(RangeError);
  });

  it("rechaza numerador no entero", () => {
    expect(() => roundDiv(10.5, 2)).toThrow(RangeError);
  });

  it("falla si el producto intermedio desborda el rango seguro", () => {
    expect(() => roundDiv(Number.MAX_SAFE_INTEGER, 1)).not.toThrow();
    expect(() => roundDiv(Number.MAX_SAFE_INTEGER + 2, 1)).toThrow(RangeError);
  });
});