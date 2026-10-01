import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { toErrorResponse } from "@/lib/errors";
import { listAdminConfig } from "@/services/admin/admin-config-service";
import { toIso } from "@/lib/loan-json";

/**
 * `GET /api/admin/config` (PROJECT_SPEC §9, F13-2b).
 *
 * Configuración completa para la pantalla de administración: productos con sus tiers, versiones de
 * tasa, umbrales de mora y canales de pago. Lectura sola, sin rate limit: abrir la pantalla no
 * escribe nada (misma regla que la cartera de F11 y el dashboard de F12).
 *
 * Las fechas viajan como ISO porque el doc las guarda como `Timestamp`: el Admin SDK devuelve
 * `Timestamp` y el `admin/page.tsx` ya normaliza con `toDate`, pero la API es pública y su
 * contrato tiene que ser JSON, no `Timestamp` (que se serializa como `{_seconds, _nanoseconds}`).
 */
export async function GET(): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    await requireAdmin({ auth, db, cookies: cookieStore });

    const config = await listAdminConfig(db);

    return Response.json(
      {
        products: config.products.map((product) => ({
          id: product.id,
          name: product.name,
          currency: product.currency,
          termFrequency: product.termFrequency,
          termInstallments: product.termInstallments,
          minTermInstallments: product.minTermInstallments,
          maxTermInstallments: product.maxTermInstallments,
          effectiveFeeBps: product.effectiveFeeBps,
          isActive: product.isActive,
          updatedAt: toIso(product.updatedAt),
          tiers: product.tiers.map((tier) => ({
            id: tier.id,
            position: tier.position,
            amountPesos: tier.amountPesos,
            minScore: tier.minScore ?? null,
            isActive: tier.isActive,
          })),
        })),
        rates: config.rates.map((rate) => ({
          id: rate.id,
          productType: rate.productType,
          version: rate.version,
          annualRateBps: rate.annualRateBps,
          maximumRateBps: rate.maximumRateBps ?? null,
          effectiveFrom: toIso(rate.effectiveFrom),
          effectiveTo: rate.effectiveTo ? toIso(rate.effectiveTo) : null,
          source: rate.source,
          isActive: rate.isActive,
          updatedAt: toIso(rate.updatedAt),
        })),
        thresholds: config.thresholds
          ? { value: config.thresholds.value, updatedAt: toIso(config.thresholds.updatedAt) }
          : null,
        channels: config.channels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          instructionsText: channel.instructionsText,
          isActive: channel.isActive,
          isDemoData: channel.isDemoData,
          legalReview: channel.legalReview,
          meta: channel.meta,
          updatedAt: toIso(channel.updatedAt),
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
