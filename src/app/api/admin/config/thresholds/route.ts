import { z } from "zod";
import { prepareAdminConfigWrite } from "@/lib/admin-config-request";
import { toErrorResponse } from "@/lib/errors";
import { formatDateTime } from "@/lib/credit-labels";
import { updateDelinquencyThresholds } from "@/services/admin/admin-config-service";

/**
 * `PATCH /api/admin/config/thresholds` (PROJECT_SPEC §9, §10.2 — F13-2b).
 *
 * Los tres cortes que gobiernan el ciclo de un préstamo: cuándo empieza a contar mora, cuándo está
 * vencido y cuándo va a mora.
 *
 * **No recalcula nada.** Los préstamos ya formalizados guardan su corte en `loans.delinquency`, así que
 * cambiar esto afecta a lo que se evalúe de aquí en adelante; para los existentes hay que correr el
 * recálculo de mora (`runDelinquencySweep`). Decirlo aquí evita el "ya lo arreglé y el caso viejo
 * sigue igual".
 *
 * El body lleva los tres campos porque se editan juntos: guardar solo uno dejaría el parche como un
 * no-op silencioso. El servicio compara contra lo guardado y rechaza sin cambios.
 *
 * El orden `dueSoonDays < overdueDays` **no** se repite aquí: vive en `parseThresholdsForWrite`, que
 * es el mismo camino que usa el servicio. Una regla en la ruta y otra en el servicio divergen en la
 * primera pantalla que se escriba de otra forma, y esa pantalla aceptaría una configuración que el
 * motor de mora no puede clasificar bien.
 */
const bodySchema = z
  .object({
    dueSoonDays: z.number().int().min(0).max(60),
    overdueDays: z.number().int().min(1).max(120),
    defaultDays: z.number().int().min(1).max(365),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export async function PATCH(request: Request): Promise<Response> {
  try {
    const { db, actor, body } = await prepareAdminConfigWrite(request, bodySchema, { rateScope: "thresholds" });

    const now = new Date();
    const thresholds = await updateDelinquencyThresholds(db, actor, body, now);

    return Response.json(
      {
        thresholds,
        savedAt: formatDateTime(now),
        note: "Los préstamos ya evaluados conservan su corte; corre el recálculo de mora para aplicarlo.",
      },
      { status: 200 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}