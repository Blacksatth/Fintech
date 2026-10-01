import { z } from "zod";
import { prepareAdminConfigWrite, requireIdempotencyKey } from "@/lib/admin-config-request";
import { toErrorResponse } from "@/lib/errors";
import { createProductTier } from "@/services/admin/admin-config-service";

/**
 * `POST /api/admin/config/tiers` (PROJECT_SPEC §6.1, §9 — F13-2b).
 *
 * Agrega un rung a la escalera de montos del producto. El doc ID es `{productCode}_{position}`
 * (§8.1) y el servicio rechaza escribir en una posición ocupada: crearla no agrega un tier, pisa el
 * que había —incluso uno desactivado— y eso se perdería sin dejar rastro.
 *
 * Pide `Idempotency-Key` (a diferencia de los parches): el id del doc se deriva de la posición, así
 * que la repetición natural de un doble clic **sí** escribiría sobre el tier recién creado. Con la
 * clave, el segundo intento es un replay y devuelve el mismo doc.
 */
const bodySchema = z
  .object({
    productCode: z.string().trim().min(1).max(50),
    position: z.number().int().min(1).max(50),
    /** Pesos enteros COP: nunca float (regla de dinero del proyecto). */
    amountPesos: z
      .number()
      .refine((value) => Number.isSafeInteger(value) && value > 0, "debe ser un entero positivo en pesos"),
    minScore: z.number().int().min(0).max(100).optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  try {
    const { db, actor, body } = await prepareAdminConfigWrite(request, bodySchema, { rateScope: "tier" });

    const now = new Date();
    const { id, doc } = await createProductTier(
      db,
      actor,
      body,
      { idempotencyKey: requireIdempotencyKey(request) },
      now,
    );

    return Response.json(
      {
        tier: {
          id,
          productCode: doc.productCode,
          position: doc.position,
          amountPesos: doc.amountPesos,
          minScore: doc.minScore ?? null,
          isActive: doc.isActive,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
