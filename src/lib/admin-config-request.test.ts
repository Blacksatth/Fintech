import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError, ErrorCode } from "@/lib/errors";
import { prepareAdminConfigWrite, requireIdempotencyKey } from "./admin-config-request";

/**
 * Tests del pegamento de las rutas de configuración.
 *
 * El orden de las comprobaciones es la parte que importa y no se ve leyendo el código: si el rate
 * limit se contara por IP o se comprobara antes de autenticar, un atacante detrás de la misma red
 * que el admin quemaría el cupo del admin. Si el Origin se comprobara después de leer la sesión,
 * una mutación_csrf gastaría una lectura de cookie sin permiso. Por eso se miden las llamadas,
 * no solo el resultado.
 */

const requireAdminMock = vi.fn();
const checkRateLimitMock = vi.fn();

vi.mock("@/lib/admin", () => ({
  getDb: () => ({}) as never,
  getAuthAdmin: () => ({}) as never,
}));

vi.mock("@/auth/guards", () => ({
  requireAdmin: (deps: unknown) => requireAdminMock(deps),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (key: string, limit: number, windowMs: number) => checkRateLimitMock(key, limit, windowMs),
  buildKey: (scope: string, subject: string, id: string) => `${scope}:${subject}:${id}`,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const schema = z.object({ reason: z.string().trim().min(3) }).strict();

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/admin/config/thresholds", {
    method: "PATCH",
    headers: { host: "localhost:3000", origin: "http://localhost:3000", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function captureError(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error("se esperaba un error y no hubo");
}

beforeEach(() => {
  requireAdminMock.mockReset();
  checkRateLimitMock.mockReset();
  requireAdminMock.mockResolvedValue({ uid: "admin-1", email: null, role: "ADMIN", status: "ACTIVE" });
  checkRateLimitMock.mockReturnValue({ allowed: true, remaining: 29, resetAt: new Date(Date.now() + 3_600_000) });
});

describe("prepareAdminConfigWrite", () => {
  it("devuelve db, actor y body ya tipado", async () => {
    const result = await prepareAdminConfigWrite(request({ reason: "subir la tasa" }), schema, { rateScope: "rate" });

    expect(result.actor).toEqual({ uid: "admin-1", role: "ADMIN" });
    expect(result.body).toEqual({ reason: "subir la tasa" });
    expect(result.db).toBeDefined();
  });

  it("rechaza el Origin antes de leer la sesión", async () => {
    const error = await captureError(() =>
      prepareAdminConfigWrite(request({ reason: "x" }, { origin: "https://evil.local.dev" }), schema, {
        rateScope: "rate",
      }),
    );

    expect(error.statusCode).toBe(403);
    // Una mutación de otro origen no debe gastar ni la sesión del admin ni su cupo de rate limit.
    expect(requireAdminMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("cuenta el rate limit por admin autenticado, no por IP", async () => {
    await prepareAdminConfigWrite(request({ reason: "subir la tasa" }), schema, { rateScope: "rate" });

    expect(checkRateLimitMock).toHaveBeenCalledTimes(1);
    const [key, limit, windowMs] = checkRateLimitMock.mock.calls[0]!;
    expect(key).toContain("admin-1");
    expect(key).toContain("rate");
    expect(limit).toBe(30);
    expect(windowMs).toBe(60 * 60 * 1000);
    // El rate limit se comprueba **después** de autenticar: sin uid no hay contra qué contar.
    expect(requireAdminMock.mock.invocationCallOrder[0]!).toBeLessThan(
      checkRateLimitMock.mock.invocationCallOrder[0]!,
    );
  });

  it("devuelve 429 con los segundos que faltan cuando el admin se pasó", async () => {
    checkRateLimitMock.mockReturnValue({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 45_000) });

    const error = await captureError(() =>
      prepareAdminConfigWrite(request({ reason: "otra vez" }), schema, { rateScope: "rate" }),
    );

    expect(error.code).toBe(ErrorCode.RATE_LIMITED);
    expect(error.statusCode).toBe(429);
    expect(error.message).toMatch(/45|46/);
  });

  it("devuelve 400 con el detalle del campo cuando el body no valida", async () => {
    const error = await captureError(() =>
      prepareAdminConfigWrite(request({}), schema, { rateScope: "rate" }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/reason/);
  });

  it("rechaza campos desconocidos en vez de ignorarlos", async () => {
    // Un `strict()` que dejara pasar un campo de más haría creer al admin que se guardó algo que no
    // existe en el servicio.
    const error = await captureError(() =>
      prepareAdminConfigWrite(request({ reason: "ok", annualRateBps: 9000 }), schema, { rateScope: "rate" }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/annualRateBps/);
  });

  it("devuelve 400 y no 500 con un body que no es JSON", async () => {
    const error = await captureError(() =>
      prepareAdminConfigWrite(request("{roto", {}), schema, { rateScope: "rate" }),
    );

    expect(error.statusCode).toBe(400);
  });

  it("propaga el 403 cuando el admin no es admin", async () => {
    requireAdminMock.mockRejectedValue(new AppError(ErrorCode.FORBIDDEN, "No tienes permiso", 403));

    const error = await captureError(() =>
      prepareAdminConfigWrite(request({ reason: "intento" }), schema, { rateScope: "rate" }),
    );

    expect(error.statusCode).toBe(403);
    // No se cuenta el rate limit de alguien que no pudo autenticarse: el cupo es del admin, no del
    // atacante.
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });
});

describe("requireIdempotencyKey", () => {
  it("devuelve la clave cuando viene", () => {
    expect(requireIdempotencyKey(new Request("http://localhost:3000", { headers: { "idempotency-key": "abc-123" } }))).toBe(
      "abc-123",
    );
  });

  it("exige la clave: es lo que impide que un doble clic publique dos versiones de tasa", () => {
    const error = (() => {
      try {
        requireIdempotencyKey(new Request("http://localhost:3000"));
      } catch (thrown) {
        return thrown as AppError;
      }
      return null;
    })();

    expect(error?.statusCode).toBe(400);
    expect(error?.message).toMatch(/Idempotency-Key/);
  });

  it("rechaza una clave absurdamente larga", () => {
    const error = (() => {
      try {
        requireIdempotencyKey(new Request("http://localhost:3000", { headers: { "idempotency-key": "x".repeat(201) } }));
      } catch (thrown) {
        return thrown as AppError;
      }
      return null;
    })();

    expect(error?.statusCode).toBe(400);
  });

  it("ignora una clave que solo son espacios", () => {
    const error = (() => {
      try {
        requireIdempotencyKey(new Request("http://localhost:3000", { headers: { "idempotency-key": "   " } }));
      } catch (thrown) {
        return thrown as AppError;
      }
      return null;
    })();

    expect(error?.statusCode).toBe(400);
  });
});