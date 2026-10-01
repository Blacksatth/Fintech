import { z } from "zod";
import { prepareAdminConfigWrite, requireIdempotencyKey } from "@/lib/admin-config-request";
import { toErrorResponse } from "@/lib/errors";
import { toIso } from "@/lib/loan-json";
import { createInterestRateVersion } from "@/services/admin/admin-config-service";

/**
 * `POST /api/admin/config/rates` (PROJECT_SPEC §6.2, §9 — F13-2b).
 *
 * Publica una **versión nueva** de la tasa del producto; nunca edita una existente (ver el servicio:
 * `resolvePricing` toma la activa y vigente de mayor versión, y cada préstamo guarda en
 * `loans.pricing` la tasa que aceptó).
 *
 * Exige `Idempotency-Key` porque el alta reserva la siguiente versión. Un doble clic sin ella
 * publicaría dos versiones con el mismo valor, y la segunda ganaría sin que nadie la pidiera.
 */
const bodySchema = z
  .object({
    productType: z.string().trim().min(1).max(50),
    /** Puntos básicos: 2400 = 24,00 % (regla de dinero del proyecto, nunca float). */
    annualRateBps: z.number().int().min(0).max(100000),
    /** Tasa máxima legal; si se supera, el motor de originación debe rechazar el crédito. */
    maximumRateBps: z.number().int().min(0).max(100000).optional(),
    /** `AAAA-MM-DD`. Se guarda a medianoche UTC del día, no "ahora". */
    effectiveFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "la fecha de vigencia debe tener el formato AAAA-MM-DD"),
    source: z.string().trim().min(3).max(200),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  try {
    const { db, actor, body } = await prepareAdminConfigWrite(request, bodySchema, { rateScope: "rate" });

    const now = new Date();
    const { id, doc, replayed } = await createInterestRateVersion(
      db,
      actor,
      body,
      { idempotencyKey: requireIdempotencyKey(request) },
      now,
    );

    return Response.json(
      {
        rate: {
          id,
          productType: doc.productType,
          version: doc.version,
          annualRateBps: doc.annualRateBps,
          maximumRateBps: doc.maximumRateBps ?? null,
          effectiveFrom: toIso(doc.effectiveFrom),
          isActive: doc.isActive,
        },
        replayed,
      },
      { status: replayed ? 200 : 201 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}