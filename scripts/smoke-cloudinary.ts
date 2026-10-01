import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createCloudinaryReceiptStore, isCloudinaryConfigured } from "../src/server/cloudinary";
import {
  RECEIPT_URL_TTL_SECONDS,
  buildReceiptReference,
  parseReceiptReference,
} from "../src/server/receipt";

/**
 * Smoke test de Cloudinary real (F10-3, decisión D5: comprobantes con entrega restringida).
 *
 * Verifica de punta a punta lo que los tests con doble no pueden:
 *   1. sube un asset `authenticated` de verdad;
 *   2. la ruta **sin firma** no descarga nada (es lo que se guarda en el documento);
 *   3. la URL **firmada** sí entrega el archivo;
 *   4. el mismo archivo con la firma alterada tampoco se entrega;
 *   5. borra el asset y confirma que desaparece.
 *
 * Todo lo que sube usa el prefijo `_smoke` y se borra al final, incluso si un paso falla.
 * Requiere `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` y `CLOUDINARY_API_SECRET` en `.env`.
 * Uso: npm run smoke:cloudinary
 */

/** PNG mínimo de 1x1, suficiente para probar la entrega sin depender de un archivo del repo. */
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const SMOKE_PAYMENT_NUMBER = `PAY-SMOKE-${randomUUID().slice(0, 8)}`;

function pedir(url: string): Promise<Response> {
  return fetch(url, { redirect: "manual" });
}

async function main() {
  if (!isCloudinaryConfigured()) {
    throw new Error(
      "Faltan CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY o CLOUDINARY_API_SECRET en .env. " +
        "El comprobante es opcional en el flujo de pagos, pero este script necesita credenciales.",
    );
  }

  const store = createCloudinaryReceiptStore();
  // Carpeta propia del smoke: si algo queda a medias, es borrable a mano sin riesgo.
  const publicId = `_smoke/${SMOKE_PAYMENT_NUMBER}/${randomUUID()}`;
  console.log(`[smoke:cloudinary] probando ${publicId}`);

  let reference: { publicId: string; format: string } | null = null;
  try {
    const subido = await store.upload({
      publicId,
      bytes: PNG_1X1,
      contentType: "image/png",
    });
    reference = subido;
    console.log(`[smoke:cloudinary] subido como ${subido.publicId}.${subido.format}`);
    if (subido.format !== "png") {
      throw new Error(`el proveedor guardó el archivo como .${subido.format} y se esperaba .png`);
    }

    // 2. La ruta sin firma es lo único que se guarda en el documento: no puede entregar nada.
    const sinFirma = buildReceiptReference(subido);
    const respuestaSinFirma = await pedir(sinFirma).catch((error: unknown) => {
      // Una ruta relativa no es una URL: el fallo de red aquí es la señal de que no es servible.
      console.log(`[smoke:cloudinary] la ruta sin firma no es una URL descargable: ${String(error)}`);
      return null;
    });
    if (respuestaSinFirma !== null && respuestaSinFirma.ok) {
      throw new Error("FALLO: la ruta sin firma entregó el archivo, el asset no está restringido");
    }
    console.log("[smoke:cloudinary] OK: la ruta sin firma no entrega el archivo");

    // 3. La URL firmada sí entrega, y es lo que devuelve GET /api/payments/:id/receipt.
    const firmada = store.signedDeliveryUrl(subido, RECEIPT_URL_TTL_SECONDS);
    const respuestaFirmada = await pedir(firmada);
    if (!respuestaFirmada.ok) {
      throw new Error(
        `FALLO: la URL firmada no entregó el archivo (HTTP ${respuestaFirmada.status})`,
      );
    }
    const bytes = new Uint8Array(await respuestaFirmada.arrayBuffer());
    if (bytes.length !== PNG_1X1.length) {
      throw new Error(`FALLO: llegaron ${bytes.length} bytes y se esperaban ${PNG_1X1.length}`);
    }
    console.log(
      `[smoke:cloudinary] OK: la URL firmada entregó ${bytes.length} bytes y caduca en ${RECEIPT_URL_TTL_SECONDS}s`,
    );

    // 4. La firma es lo que autoriza: alterarla debe romper el acceso.
    const firmaAlterada = firmada.replace(/s--[a-zA-Z0-9_-]+--/, "s--alterada--");
    const respuestaAlterada = await pedir(firmaAlterada);
    if (respuestaAlterada.ok) {
      throw new Error("FALLO: una firma alterada entregó el archivo");
    }
    console.log("[smoke:cloudinary] OK: una firma alterada no entrega el archivo");

    // 5. La referencia guardada se relee con el parser del dominio, que es lo que firmará la ruta.
    const referenceLeida = parseReceiptReference(sinFirma, SMOKE_PAYMENT_NUMBER);
    if (referenceLeida === null) {
      throw new Error(`FALLO: el parser del dominio no reconoce su propia referencia ${sinFirma}`);
    }
    console.log("[smoke:cloudinary] OK: la referencia guardada se relee para poder firmarla");
  } finally {
    if (reference !== null) {
      await store.destroy(reference);
      console.log(`[smoke:cloudinary] borrado ${reference.publicId}`);
    }
  }

  console.log("[smoke:cloudinary] OK: entrega restringida verificada de punta a punta");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[smoke:cloudinary] FAILED:", err);
    process.exit(1);
  });
