import { describe, expect, it } from "vitest";
import { assertSameOrigin, isSameOrigin, originCheckFrom } from "./origin";

const httpLocal = { host: "localhost:3000", protocol: "http:" };
const httpsLocal = { host: "localhost:3000", protocol: "https:" };

function request(headers: Record<string, string>, url = "http://localhost:3000/api/auth/session"): Request {
  return new Request(url, { method: "POST", headers });
}

describe("isSameOrigin", () => {
  it("acepta mismo esquema, host y puerto", () => {
    expect(isSameOrigin("http://localhost:3000", httpLocal)).toBe(true);
    expect(isSameOrigin("https://app.local.dev", { host: "app.local.dev", protocol: "https:" })).toBe(true);
  });

  it("rechaza host distinto", () => {
    expect(isSameOrigin("https://evil.local.dev", httpLocal)).toBe(false);
  });

  it("rechaza puerto distinto", () => {
    expect(isSameOrigin("http://localhost:3001", httpLocal)).toBe(false);
  });

  it("rechaza esquema distinto: el origen incluye esquema, host y puerto", () => {
    expect(isSameOrigin("https://localhost:3000", httpLocal)).toBe(false);
    expect(isSameOrigin("http://localhost:3000", httpsLocal)).toBe(false);
  });

  it("permite peticiones sin Origin (no navegador) y rechaza Origin inválido", () => {
    expect(isSameOrigin(undefined, httpLocal)).toBe(true);
    expect(isSameOrigin("no-es-una-url", httpLocal)).toBe(false);
  });

  it("rechaza si no se puede determinar el host esperado", () => {
    expect(isSameOrigin("http://localhost:3000", { host: null, protocol: "http:" })).toBe(false);
  });
});

describe("originCheckFrom", () => {
  it("usa el header host y el protocolo de la URL cuando no hay x-forwarded-proto", () => {
    expect(originCheckFrom(request({ host: "localhost:3000" }))).toEqual({
      host: "localhost:3000",
      protocol: "http:",
    });
  });

  it("respeta x-forwarded-proto (típico detrás de un proxy)", () => {
    expect(originCheckFrom(request({ host: "app.local.dev", "x-forwarded-proto": "https, http" }))).toEqual({
      host: "app.local.dev",
      protocol: "https:",
    });
  });

  it("no confía en x-forwarded-host para decidir el origen", () => {
    const check = originCheckFrom(request({ host: "localhost:3000", "x-forwarded-host": "evil.local.dev" }));
    expect(check.host).toBe("localhost:3000");
    expect(isSameOrigin("https://evil.local.dev", check)).toBe(false);
  });
});

describe("assertSameOrigin", () => {
  it("no lanza si el Origin coincide o no viene", () => {
    expect(() => assertSameOrigin(request({ host: "localhost:3000", origin: "http://localhost:3000" }))).not.toThrow();
    expect(() => assertSameOrigin(request({ host: "localhost:3000" }))).not.toThrow();
  });

  it("lanza 403 si el Origin es de otro origen", () => {
    expect(() => assertSameOrigin(request({ host: "localhost:3000", origin: "https://evil.local.dev" }))).toThrow(
      /origen/i,
    );
    try {
      assertSameOrigin(request({ host: "localhost:3000", origin: "https://evil.local.dev" }));
    } catch (error) {
      expect(error).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    }
  });

  it("rechaza el mismo host servido por otro esquema", () => {
    expect(() => assertSameOrigin(request({ host: "localhost:3000", origin: "https://localhost:3000" }))).toThrow(
      /origen/i,
    );
  });
});
