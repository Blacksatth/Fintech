import { ZodError } from "zod";

export const ErrorCode = {
  VALIDATION: "VALIDATION",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function badRequest(message = "Solicitud invalida"): AppError {
  return new AppError(ErrorCode.VALIDATION, message, 400);
}

export function unauthorized(message = "No autenticado"): AppError {
  return new AppError(ErrorCode.UNAUTHORIZED, message, 401);
}

export function forbidden(message = "No autorizado"): AppError {
  return new AppError(ErrorCode.FORBIDDEN, message, 403);
}

export function notFound(message = "Recurso no encontrado"): AppError {
  return new AppError(ErrorCode.NOT_FOUND, message, 404);
}

export function conflict(message = "Conflicto de estado"): AppError {
  return new AppError(ErrorCode.CONFLICT, message, 409);
}

export function tooManyRequests(message = "Demasiadas solicitudes"): AppError {
  return new AppError(ErrorCode.RATE_LIMITED, message, 429);
}

export function internal(message = "Error interno"): AppError {
  return new AppError(ErrorCode.INTERNAL, message, 500);
}

/**
 * Una dependencia caída (almacenamiento, proveedor externo). Distinta de `internal` porque la
 * acción es reintentable por el usuario y no es un fallo del servidor.
 */
export function serviceUnavailable(message = "Servicio no disponible"): AppError {
  return new AppError(ErrorCode.INTERNAL, message, 503);
}

export function toErrorResponse(err: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (err instanceof AppError) {
    return { status: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { status: 400, body: { error: { code: ErrorCode.VALIDATION, message } } };
  }
  return { status: 500, body: { error: { code: ErrorCode.INTERNAL, message: "Error interno" } } };
}