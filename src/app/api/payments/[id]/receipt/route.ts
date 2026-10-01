import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { badRequest, toErrorResponse, tooManyRequests } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/origin";
import { buildKey, checkRateLimit } from "@/lib/rate-limit";
import { MAX_RECEIPT_BYTES } from "@/server/receipt";
import { attachPaymentReceipt, getPaymentReceiptUrl } from "@/services/payments/receipt-service";
import { createCloudinaryReceiptStore } from "@/server/cloudinary";

/**
 * Comprobante de un pago (PROJECT_SPEC §9 y §11, F10-3).
 *
 * - `POST /api/payments/:id/receipt` (multipart `file`): el titular adjunta su comprobante a un
 *   pago `PENDING`. **Opcional**: §11 exige que un pago se pueda registrar sin comprobante.
 * - `GET /api/payments/:id/receipt`: devuelve una **URL firmada** de caducidad corta, para el
 *   titular o para un ADMIN. Nunca se devuelve una URL que se pueda reutilizar: la que se firma
 *   aquí expira en minutos.
 *
 * Comprobante en Firestore, entrega en Cloudinary y permiso en el servidor: el navegador nunca
 * habla con el proveedor (decisión D5).
 */

/**
 * Holgura sobre los 5 MB para la multipart en sí (nombres, cabeceras, el límite del campo).
 * Solo se usa con `Content-Length`: si el cliente no lo manda, la validación real es la del
 * dominio, sobre los bytes ya leídos.
 */
const MULTIPART_SLACK_BYTES = 64 * 1024;

/**
 * Una subida cuesta dinero (ancho de banda y almacenamiento del proveedor), así que el límite es
 * más estrecho que el de "registrar pago". En memoria y por instancia: es la limitación ya asumida
 * en PROJECT_SPEC §15, no una garantía global.
 */
const UPLOAD_LIMIT = 20;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

/** Extrae el archivo del multipart y lo pasa al validador del dominio. */
async function readReceiptFile(request: Request) {
  const declarado = request.headers.get("content-length");
  if (declarado !== null) {
    const total = Number(declarado);
    if (Number.isFinite(total) && total > MAX_RECEIPT_BYTES + MULTIPART_SLACK_BYTES) {
      // Se rechaza antes de leer el cuerpo: un archivo de 500 MB no debería llegar a estar en la
      // memoria del proceso. 400 y no 413 para que el mensaje sea el mismo que el del validador.
      throw badRequest("El comprobante supera el máximo de 5 MB");
    }
  }

  const form = await request.formData();
  const archivo = form.get("file");
  if (archivo === null) {
    throw badRequest("Falta el archivo del comprobante en el campo 'file'");
  }
  // Un `File` es un `Blob` con nombre; un string (o un array) es un campo de formulario normal.
  if (typeof archivo === "string" || !(archivo instanceof Blob)) {
    throw badRequest("El campo 'file' debe ser el archivo del comprobante");
  }
  if (archivo.size === 0) {
    throw badRequest("El comprobante está vacío");
  }

  return {
    filename: archivo instanceof File ? archivo.name : "comprobante",
    declaredType: archivo.type,
    bytes: new Uint8Array(await archivo.arrayBuffer()),
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(request);

    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    const context = await requireUser({ auth, db, cookies: cookieStore });
    const { id } = await params;

    const limite = checkRateLimit(
      buildKey("payments.receipt.upload", context.uid),
      UPLOAD_LIMIT,
      UPLOAD_WINDOW_MS,
    );
    if (!limite.allowed) {
      const { body } = toErrorResponse(
        tooManyRequests("Demasiadas subidas de comprobante. Intenta de nuevo más tarde"),
      );
      const retryAfter = Math.max(1, Math.ceil((limite.resetAt.getTime() - Date.now()) / 1000));
      return Response.json(body, { status: 429, headers: { "Retry-After": String(retryAfter) } });
    }

    const file = await readReceiptFile(request);
    const receipt = await attachPaymentReceipt(
      { db, store: createCloudinaryReceiptStore() },
      { paymentId: id, actor: { uid: context.uid, role: context.role }, file },
    );

    // 200 y no 201: la ruta es la misma y el pago ya existía. Lo que se acaba de crear es el
    // comprobante, y la respuesta no lleva ninguna URL: para verlo hay que pedir la firmada.
    return Response.json({ receipt }, { status: 200 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    // Sin `assertSameOrigin`: esto es una lectura, y no muta nada. Firestore y la firma son lo
    // único que se ejecutan, y ninguno de los dos cobra por reintentos.
    const context = await requireUser({ auth, db, cookies: cookieStore });
    const { id } = await params;

    const receipt = await getPaymentReceiptUrl(
      { db, store: createCloudinaryReceiptStore() },
      { paymentId: id, actor: { uid: context.uid, role: context.role } },
    );

    return Response.json({ receipt }, { status: 200 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
