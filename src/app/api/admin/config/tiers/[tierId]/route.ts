import { z } from "zod";
import { prepareAdminConfigWrite } from "@/lib/admin-config-request";
import { toErrorResponse } from "@/lib/errors";
import { updateProductTier } from "@/services/admin/admin-config-service";

/**
 * `PATCH /api/admin/config/tiers/:tierId` (PROJECT_SPEC §6.1, §9 — F13-2b).
 *
 * Edita monto, `minScore` y activo/inactivo de un rung.
 *
 * `productCode` y `position` **no** son editables: forman el doc ID (`{code}_{position}`) y la
 * escalera se ordena por posición. Mover un rung sería cambiar su identidad, no su valor; para eso
 * se desactiva el viejo y se da de alta el nuevo en la posición destino.
 */
const bodySchema = z
  .object({
    amountPesos: z
      .number()
      .refine((value) => Number.isSafeInteger(value) && value > 0, "debe ser un entero positivo en pesos")
      .optional(),
    minScore: z.number().int().min(0).max(100).optional(),
    isActive: z.boolean().optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ tierId: string }> },
): Promise<Response> {
  try {
    const { tierId } = await params;
    const { db, actor, body } = await prepareAdminConfigWrite(request, bodySchema, { rateScope: "tier" });

    const now = new Date();
    const { id, doc } = await updateProductTier(db, actor, { tierId, ...body }, now);

    return Response.json(
      {
        tier: {
          id,
          position: doc.position,
          amountPesos: doc.amountPesos,
          minScore: doc.minScore ?? null,
          isActive: doc.isActive,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}