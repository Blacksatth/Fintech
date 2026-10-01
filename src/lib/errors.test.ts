import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  ErrorCode,
  internal,
  notFound,
  tooManyRequests,
  toErrorResponse,
  unauthorized,
} from "./errors";

describe("errors (códigos JSON seguros)", () => {
  it("AppError expone code y status", () => {
    const err = unauthorized();
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(err.statusCode).toBe(401);
  });

  it("las fábricas mapean códigos a HTTP", () => {
    expect(badRequest().statusCode).toBe(400);
    expect(forbidden().statusCode).toBe(403);
    expect(notFound().statusCode).toBe(404);
    expect(conflict().statusCode).toBe(409);
    expect(tooManyRequests().statusCode).toBe(429);
    expect(internal().statusCode).toBe(500);
  });

  it("toErrorResponse: AppError -> JSON seguro", () => {
    const res = toErrorResponse(conflict("estado en conflicto"));
    expect(res).toEqual({
      status: 409,
      body: { error: { code: "CONFLICT", message: "estado en conflicto" } },
    });
  });

  it("toErrorResponse: ZodError -> 400 VALIDATION", () => {
    const zodErr = z.object({ a: z.number() }).safeParse({ a: "x" }).error!;
    const res = toErrorResponse(zodErr);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION);
    expect(res.body.error.message).toContain("a");
  });

  it("toErrorResponse: errores desconocidos nunca filtran internos", () => {
    const res = toErrorResponse(new Error("stack secreto: DB_PASSWORD"));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: ErrorCode.INTERNAL, message: "Error interno" },
    });
    expect(JSON.stringify(res)).not.toContain("DB_PASSWORD");
  });
});