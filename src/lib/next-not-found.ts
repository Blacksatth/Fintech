import { notFound } from "next/navigation";
import { AppError, ErrorCode } from "@/lib/errors";

/**
 * Traduce el `NOT_FOUND` de un servicio a la 404 de Next; cualquier otro error sube tal cual.
 *
 * Sin esto, una página que llama a un servicio que lanza `notFound(...)` (un préstamo inexistente,
 * por ejemplo) se rompe con un **500**: el `AppError` no lo entiende el render de Next y aparece
 * "This page couldn't load" en vez de un 404 con salida. En las rutas HTTP no pasa porque
 * `toErrorResponse` traduce el mismo error a 404.
 *
 * Pensado para `await servicio(...).catch(rethrowAsNotFound)`.
 */
export function rethrowAsNotFound(error: unknown): never {
  if (error instanceof AppError && error.code === ErrorCode.NOT_FOUND) {
    notFound();
  }
  throw error;
}
