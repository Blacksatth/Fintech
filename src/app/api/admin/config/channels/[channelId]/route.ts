import { z } from "zod";
import { prepareAdminConfigWrite } from "@/lib/admin-config-request";
import { toErrorResponse, badRequest } from "@/lib/errors";
import { formatDateTime } from "@/lib/credit-labels";
import { updatePaymentChannel } from "@/services/admin/admin-config-service";
import {
  PAYMENT_CHANNEL_PUBLIC_META_KEYS,
  PaymentChannelType,
} from "@/server/payment-doc";

/**
 * `PATCH /api/admin/config/channels/:channelId` (PROJECT_SPEC §6.3, §9 — F13-2b).
 *
 * Edita nombre, instrucciones, activo/inactivo y los **datos públicos** del canal (cuenta, tipo de
 * cuenta, banco, referencia, teléfono… los que el allowlist admita).
 *
 * `meta` es un objeto abierto en el schema y aquí se filtra contra `PAYMENT_CHANNEL_PUBLIC_META_KEYS`
 * como claves del `record`: si pasara `meta.legalReview` o `meta.demo` la request muere con un 400
 * legible. Sin ese filtro un admin podría marcarse a sí mismo la revisión legal como aprobada. La
 * allowlist vive en `payment-doc` y no en la ruta a propósito: la comparten el servicio de pagos
 * (que decide qué se expone al cliente) y este endpoint (que decide qué se puede escribir).
 *
 * `type` no se edita porque **es** el doc ID (§8.1): cambiarlo no renombraría nada, crearía otro
 * canal y dejaría los pagos ya registrados apuntando al anterior.
 */
const bodySchema = z
  .object({
    name: z.string().trim().min(3).max(80).optional(),
    instructionsText: z.string().trim().min(3).max(400).optional(),
    isActive: z.boolean().optional(),
    /**
     * `z.enum` sobre las claves del record: una clave fuera del allowlist es un 400 legible, no un
     * 500. Los valores son texto porque eso es lo que el schema de canal y la proyección pública
     * asumen (número de cuenta, banco, URL del QR); el schema del doc acepta `unknown`, el parche de
     * configuración no.
     */
    publicMeta: z.record(z.enum(PAYMENT_CHANNEL_PUBLIC_META_KEYS), z.string().trim().max(160)).optional(),
    /**
     * Marca de que el banco reemplazó los datos de la cuenta. Es irreversible a propósito: limpia el
     * `meta.demo` y deja el canal esperando revisión legal. Volver atrás es una tarea legal, no un
     * click de "deshacer".
     */
    dataReplaced: z.boolean().optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> },
): Promise<Response> {
  try {
    const { channelId: rawId } = await params;
    const channelId = z.enum(PaymentChannelType).safeParse(rawId);
    if (!channelId.success) {
      // Un id fuera del enum no puede ser un canal, pero tampoco es un 404 honesto: el cliente se
      // equivocó al armar la URL, y eso se dice antes de tocar Firestore.
      throw badRequest(`Canal de pago desconocido: ${rawId}`);
    }

    const { db, actor, body } = await prepareAdminConfigWrite(request, bodySchema, { rateScope: "channel" });

    const now = new Date();
    const doc = await updatePaymentChannel(db, actor, { channelId: channelId.data, ...body }, now);

    return Response.json(
      {
        channel: {
          id: channelId.data,
          name: doc.name,
          instructionsText: doc.instructionsText,
          isActive: doc.isActive,
          meta: doc.meta,
        },
        savedAt: formatDateTime(now),
      },
      { status: 200 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}