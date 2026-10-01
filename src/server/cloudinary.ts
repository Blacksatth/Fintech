import {
  v2 as cloudinary,
  type UploadApiOptions,
  type UploadApiResponse,
} from "cloudinary";
import { getEnv } from "@/lib/env";
import {
  RECEIPT_RESOURCE_TYPE,
  ReceiptStorageError,
  type ReceiptReference,
  type ReceiptStore,
} from "./receipt";

/**
 * Comprobantes en **Cloudinary** con entrega restringida (PROJECT_SPEC §11, decisión D5: sin
 * Firebase Storage).
 *
 * - `type: "authenticated"`: el asset **no** se entrega sin una URL firmada. Un `public_id`
 *   adivinado, o el `secure_url` que devuelve la subida, no descargan nada.
 * - El `api_secret` solo existe aquí, en el servidor. El navegador nunca habla con Cloudinary.
 * - `overwrite: false`: cada comprobante es un archivo nuevo, así que no hay una versión anterior
 *   que un link viejo pueda seguir descargando.
 *
 * Toda la lógica de qué es un comprobante válido y de a qué pago pertenece vive en
 * `src/server/receipt.ts`; aquí solo se habla con el proveedor.
 */

const DELIVERY_TYPE = "authenticated";

let configurado = false;

function configure(): void {
  if (configurado) return;
  const env = getEnv();
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env;

  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new ReceiptStorageError(
      "El almacenamiento de comprobantes no está configurado (faltan CLOUDINARY_CLOUD_NAME, " +
        "CLOUDINARY_API_KEY o CLOUDINARY_API_SECRET). El pago se puede registrar sin comprobante.",
      503,
    );
  }

  // `config()` es process-global, como avisa el SDK: se hace una vez y con valores explícitos, no
  // por la variable CLOUDINARY_URL que este proyecto no usa.
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  configurado = true;
}

function messageOf(error: unknown): string {
  const e = error as { message?: string; error?: { message?: string } };
  return e?.error?.message ?? e?.message ?? "error desconocido del proveedor de comprobantes";
}

/**
 * `uploader.upload` acepta rutas y URLs; los bytes de un request HTTP van por `upload_stream`, que
 * además evita escribir el archivo en disco para volver a subirlo.
 */
function uploadStream(options: UploadApiOptions, bytes: Uint8Array): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) {
        reject(new ReceiptStorageError(`No se pudo subir el comprobante: ${messageOf(error)}`));
        return;
      }
      if (!result) {
        reject(new ReceiptStorageError("El proveedor no devolvió datos de la subida"));
        return;
      }
      resolve(result);
    });
    stream.on("error", (error: Error) => {
      reject(new ReceiptStorageError(`No se pudo subir el comprobante: ${messageOf(error)}`));
    });
    // `uploader.upload` acepta rutas y URLs; un buffer de un request HTTP va por `upload_stream`.
    stream.end(Buffer.from(bytes));
  });
}

/**
 * Implementación real de `ReceiptStore`. Se crea por request (o se comparte): no guarda estado
 * más allá de la configuración del SDK, que ya es global al proceso.
 */
export function createCloudinaryReceiptStore(): ReceiptStore {
  return {
    async upload({ publicId, bytes }) {
      configure();
      const result = await uploadStream(
        {
          public_id: publicId,
          type: DELIVERY_TYPE,
          resource_type: RECEIPT_RESOURCE_TYPE,
          overwrite: false,
          invalidate: false,
        },
        bytes,
      );
      return { publicId: result.public_id, format: result.format };
    },

    signedDeliveryUrl(reference: ReceiptReference, ttlSeconds: number) {
      configure();
      // `private_download_url` es la forma documentada de servir un asset `private`/`authenticated`
      // con caducidad: firma la ruta y nadie más puede deducirla.
      return cloudinary.utils.private_download_url(reference.publicId, reference.format, {
        resource_type: RECEIPT_RESOURCE_TYPE,
        type: DELIVERY_TYPE,
        expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
    },

    async destroy(reference: ReceiptReference) {
      configure();
      try {
        await cloudinary.uploader.destroy(reference.publicId, {
          resource_type: RECEIPT_RESOURCE_TYPE,
          type: DELIVERY_TYPE,
          invalidate: true,
        });
      } catch (error) {
        // Borrar es una limpieza: si el proveedor falla, el archivo se queda huérfano, pero la
        // operación que lo motivó (quitar el comprobante viejo) ya se resolvió. Se informa sin
        // tumbar la respuesta que el usuario espera.
        console.error(
          `[receipts] no se pudo borrar el comprobante ${reference.publicId}: ${messageOf(error)}`,
        );
      }
    },
  };
}

/** Permite probar el módulo (imports, configuración) sin tocar la red. */
export function isCloudinaryConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}
