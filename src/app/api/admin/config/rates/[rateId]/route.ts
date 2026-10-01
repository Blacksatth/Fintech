import { z } from "zod";
import { prepareAdminConfigWrite } from "@/lib/admin-config-request";
import { toErrorResponse } from "@/lib/errors";
import { setInterestRateActive } from "@/services/admin/admin-config-service";

/**
 * `PATCH /api/admin/config/rates/:rateId` (PROJECT_SPEC §6.2, §9 — F13-2b).
 *
 * Lo único editable de una tasa es `isActive`. Los importes de una versión publicada no se tocan:
 * cambiarlos en el sitio reescribiría la historia de los préstamos que se crearon con ella, que es
 * justamente lo que hace auditable un préstamo. Para cambiar la tasa se publica una versión nueva.
 *
 * Desactivar la última tasa activa de un producto activo se rechaza: el producto quedaría vendiendo
 * sin tasa. La salida es desactivar el producto, no dejar el catálogo en un estado imposible.
 */
const bodySchema = z
  .object({
    isActive: z.boolean(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ rateId: string }> },
): Promise<Response> {
  try {
    const { rateId } = await params;
    const { db, actor, body } = await prepareAdminConfigWrite(request, bodySchema, { rateScope: "rate" });

    const now = new Date();
    const { id, doc } = await setInterestRateActive(db, actor, { rateId, ...body }, now);

    return Response.json({ rate: { id, version: doc.version, isActive: doc.isActive } }, { status: 200 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}