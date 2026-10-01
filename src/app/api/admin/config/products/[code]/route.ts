import { z } from "zod";
import { prepareAdminConfigWrite } from "@/lib/admin-config-request";
import { toErrorResponse } from "@/lib/errors";
import { updateCreditProduct } from "@/services/admin/admin-config-service";
import { TermFrequency } from "@/server/types";
import { formatDateTime } from "@/lib/credit-labels";

/**
 * `PATCH /api/admin/config/products/:code` (PROJECT_SPEC §6.1, §9 — F13-2b).
 *
 * Edita los términos del producto: nombre, periodicidad, rango de cuotas, tarifa efectiva y
 * activo/inactivo.
 *
 * **No cambia los préstamos ya creados.** Cada préstamo guarda su snapshot en `loans.pricing`, así
 * que tocar la tarifa o la periodicidad solo afecta a lo que se solicite de aquí en adelante. Por
 * eso la operación no necesita migración: es la razón de que el snapshot exista (F8-2).
 *
 * No pide `Idempotency-Key`: el doc vive en `{code}` y repetir el PATCH es last-write-wins sobre el
 * mismo documento. La historia queda en `audit_logs` con `CONFIG_CHANGED` y el diff campo a campo.
 */
const bodySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    termFrequency: z.enum([TermFrequency.WEEKLY, TermFrequency.BIWEEKLY, TermFrequency.MONTHLY]).optional(),
    termInstallments: z.number().int().min(2).max(60).optional(),
    minTermInstallments: z.number().int().min(2).max(60).optional(),
    maxTermInstallments: z.number().int().min(2).max(60).optional(),
    effectiveFeeBps: z.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().optional(),
    /** Obligatorio: una configuración sin explicación de por qué cambió no es auditable. */
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  try {
    const { code } = await params;
    const { db, actor, body } = await prepareAdminConfigWrite(request, bodySchema, { rateScope: "product" });

    const now = new Date();
    const doc = await updateCreditProduct(db, actor, { productCode: code, ...body }, now);

    return Response.json(
      {
        product: {
          id: code,
          name: doc.name,
          termFrequency: doc.termFrequency,
          termInstallments: doc.termInstallments,
          minTermInstallments: doc.minTermInstallments,
          maxTermInstallments: doc.maxTermInstallments,
          effectiveFeeBps: doc.effectiveFeeBps,
          isActive: doc.isActive,
          updatedAt: doc.updatedAt,
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
