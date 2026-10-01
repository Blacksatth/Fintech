import { beforeEach, describe, expect, it } from "vitest";
import { buildKey, checkRateLimit, resetRateLimits } from "./rate-limit";

describe("rate-limit (ventana in-memory)", () => {
  beforeEach(() => resetRateLimits());

  it("permite hasta el limite y luego niega", () => {
    const key = "req|1.2.3.4|/api/payments";
    expect(checkRateLimit(key, 3, 60_000).allowed).toBe(true);
    expect(checkRateLimit(key, 3, 60_000).allowed).toBe(true);
    expect(checkRateLimit(key, 3, 60_000).allowed).toBe(true);
    const denied = checkRateLimit(key, 3, 60_000);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("la ventana expirada reinicia el contador", () => {
    const key = "k";
    checkRateLimit(key, 1, 10);
    expect(checkRateLimit(key, 1, 10).allowed).toBe(false);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(checkRateLimit(key, 1, 10).allowed).toBe(true);
        resolve();
      }, 20);
    });
  });

  it("claves distintas son independientes", () => {
    checkRateLimit("a", 1, 60_000);
    expect(checkRateLimit("b", 1, 60_000).allowed).toBe(true);
    expect(checkRateLimit("a", 1, 60_000).allowed).toBe(false);
  });

  it("buildKey ignora partes vacias", () => {
    expect(buildKey("1.2.3.4", "", "/api/x", undefined)).toBe("1.2.3.4|/api/x");
  });

  it("buildKey une identificador, ruta e ip", () => {
    expect(buildKey("1.2.3.4", "/api/payments", "kuotak-99")).toBe("1.2.3.4|/api/payments|kuotak-99");
  });
});