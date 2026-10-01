import { notFound } from "@/lib/errors";

export interface OwnedByUser {
  userId: string;
}

/**
 * Devuelve el documento si es del usuario; si no existe **o es de otro**, lanza el mismo 404.
 *
 * Un 403 en un recurso propiedad del usuario revelaría su existencia: basta con recorrer ids
 * y ver que el 404 se convierte en 403 para saber qué loans o solicitudes existen ajenas. Por
 * eso los dos casos son indistinguibles, incluso en el mensaje.
 *
 * Esto NO aplica al permiso por rol (`requireRole`): un CUSTOMER que entra a una ruta de
 * ADMIN sí recibe 403, porque ahí no se está revelando la existencia de nada.
 */
export function assertOwnedBy<T extends OwnedByUser>(
  doc: T | null | undefined,
  userId: string,
  message: string,
): T {
  if (!doc || doc.userId !== userId) {
    throw notFound(message);
  }
  return doc;
}
