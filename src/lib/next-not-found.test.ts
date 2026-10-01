import { describe, expect, it } from "vitest";
import { AppError, ErrorCode, notFound as appNotFound, internal } from "./errors";
import { rethrowAsNotFound } from "./next-not-found";

/**
 * El caso que motivó el helper: `/admin/prestamos/:id` daba 500 con "This page couldn't load" al
 * pedir un préstamo inexistente, porque el `notFound` del servicio no lo entiende el render de Next.
 */
describe("rethrowAsNotFound", () => {
  it("convierte un NOT_FOUND del servicio en la 404 de Next", () => {
    try {
      rethrowAsNotFound(appNotFound("Préstamo no encontrado"));
      expect.unreachable("tenía que lanzar la 404 de Next");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      // `notFound()` de Next lanza con este digest; es lo que hace que la respuesta sea 404.
      expect(String((error as { digest?: string }).digest)).toContain("404");
    }
  });

  it("deja subir cualquier otro AppError (no lo convierte en 404)", () => {
    const error = internal("Firestore caído");
    expect(() => rethrowAsNotFound(error)).toThrow(error);
  });

  it("deja subir los errores que no son AppError", () => {
    const error = new TypeError("no soy un AppError");
    expect(() => rethrowAsNotFound(error)).toThrow(error);
  });

  it("un NOT_FOUND de otra fuente tampoco se toca", () => {
    // La comparación es por `code`, no por mensaje: un 404 ajeno no debe convertirse en 404 de Next
    // sin comprobar que viene de la capa de dominio.
    const error = new AppError(ErrorCode.CONFLICT, "conflicto", 409);
    expect(() => rethrowAsNotFound(error)).toThrow(error);
  });
});
