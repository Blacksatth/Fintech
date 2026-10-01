import { getDb } from "@/lib/admin";
import { listAdminConfig } from "@/services/admin/admin-config-service";
import { formatDateTime } from "@/lib/credit-labels";
import { ProductTermsForm } from "@/components/admin/product-terms-form";
import { TierEditor } from "@/components/admin/tier-editor";
import { InterestRatesPanel } from "@/components/admin/interest-rates-panel";
import { ThresholdsForm } from "@/components/admin/thresholds-form";
import { ChannelForms } from "@/components/admin/channel-forms";
import { ConfigWorkspace, type ConfigPanelInput } from "@/components/admin/config-workspace";
import type { SystemConfigDoc } from "@/server/credit-doc";
import type { DelinquencyThresholds } from "@/server/delinquency";

/** Último recurso si `system_config/delinquency` nunca existió: los valores de PROJECT_SPEC §13. */
const FALLBACK_THRESHOLDS: DelinquencyThresholds = { dueSoonDays: 3, overdueDays: 15, defaultDays: 30 };

function readThresholds(doc: SystemConfigDoc | null): DelinquencyThresholds {
  const value = doc?.value as Partial<DelinquencyThresholds> | undefined;
  if (!value || typeof value !== "object") return FALLBACK_THRESHOLDS;
  return {
    dueSoonDays: typeof value.dueSoonDays === "number" ? value.dueSoonDays : FALLBACK_THRESHOLDS.dueSoonDays,
    overdueDays: typeof value.overdueDays === "number" ? value.overdueDays : FALLBACK_THRESHOLDS.overdueDays,
    defaultDays: typeof value.defaultDays === "number" ? value.defaultDays : FALLBACK_THRESHOLDS.defaultDays,
  };
}

/** Fechas a `YYYY-MM-DD`. Los docs las guardan como `Timestamp`; también acepta `Date`. */
function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value && typeof value === "object" && "toMillis" in value) {
    return new Date((value as { toMillis(): number }).toMillis()).toISOString().slice(0, 10);
  }
  return String(value ?? "");
}

/**
 * Configuración del producto (F13-2b, PROJECT_SPEC §6, §9).
 *
 * Las cinco cosas que un ADMIN puede cambiar, en pestañas, con **un** motivo por tanda:
 *
 *  - **Producto**: nombre, periodicidad, plazo y tarifa efectiva.
 *  - **Montos**: la escalera de tiers que decide cuánto puede pedir cada cliente.
 *  - **Tasa**: el historial de versiones y la publicación de una nueva.
 *  - **Mora**: los tres cortes del ciclo de atraso.
 *  - **Canales**: los datos de pago que ve el cliente y si ya son reales.
 *
 * La pantalla se arma con `listAdminConfig` —una lectura, sin `where + orderBy`, porque el índice
 * compuesto no se puede desplegar en el proyecto real— y delega cada escritura en el servicio, que
 * es quien conoce las invariantes entre documentos.
 *
 * Se muestra **un** producto, no un selector: el negocio tiene uno solo (una Hipotecaria no aplica a
 * microcrédito). Cuando haya más de uno, esta pantalla se parte en tabs por `productCode` en lugar de
 * inventar un selector que además tendría que filtrar las tasas por el código elegido.
 */
export default async function AdminConfigPage() {
  const config = await listAdminConfig(getDb());
  const product = config.products[0];
  const thresholds = readThresholds(config.thresholds);

  const panels: ConfigPanelInput[] = [];

  panels.push({
    id: "producto",
    label: "Producto",
    content: product ? (
      <div className="rounded-lg border border-border bg-surface p-5">
        <h2 className="text-base font-semibold text-ink">Términos del producto</h2>
        <p className="mt-1 text-sm text-ink-muted">
          <span className="font-mono text-xs">{product.id}</span> · activo desde{" "}
          {formatDateTime(product.createdAt, "siempre")} · los cambios solo aplican a solicitudes nuevas
        </p>
        <div className="mt-4">
          <ProductTermsForm
            productCode={product.id}
            initial={{
              name: product.name,
              termFrequency: product.termFrequency,
              termInstallments: product.termInstallments,
              minTermInstallments: product.minTermInstallments,
              maxTermInstallments: product.maxTermInstallments,
              effectiveFeeBps: product.effectiveFeeBps,
              isActive: product.isActive,
            }}
          />
        </div>
      </div>
    ) : (
      <div className="rounded-lg border border-border bg-surface p-5">
        <h2 className="text-base font-semibold text-ink">Sin producto configurado</h2>
        <p className="mt-1 text-sm text-ink-muted">
          No hay ningún documento en <code>credit_products</code>. Ejecuta el seed de crédito antes de
          configurar.
        </p>
      </div>
    ),
  });

  if (product) {
    panels.push({
      id: "montos",
      label: "Montos",
      content: (
        <div className="rounded-lg border border-border bg-surface p-5">
          <h2 className="text-base font-semibold text-ink">Escalera de montos</h2>
          <p className="mt-1 text-sm text-ink-muted">
            El motor elige el tier por historial de pagos y baja al mayor monto que quepa en el límite
            del cliente, así que los montos deben subir con la posición.
          </p>
          <div className="mt-4">
            <TierEditor
              productCode={product.id}
              tiers={product.tiers.map((tier) => ({
                id: tier.id,
                position: tier.position,
                amountPesos: tier.amountPesos,
                minScore: tier.minScore ?? null,
                isActive: tier.isActive,
              }))}
            />
          </div>
        </div>
      ),
    });

    const rates = config.rates.filter((rate) => rate.productType === product.id);

    panels.push({
      id: "tasa",
      label: "Tasa",
      content: (
        <div className="rounded-lg border border-border bg-surface p-5">
          <h2 className="text-base font-semibold text-ink">Tasa de interés</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Las tasas no se editan: se versionan. Cada publicación crea una versión nueva y deja las
            anteriores como registro de lo que aceptó cada cliente.
          </p>
          <div className="mt-4">
            <InterestRatesPanel
              productType={product.id}
              rates={rates.map((rate) => ({
                id: rate.id,
                version: rate.version,
                annualRateBps: rate.annualRateBps,
                maximumRateBps: rate.maximumRateBps ?? null,
                effectiveFrom: isoDate(rate.effectiveFrom),
                effectiveTo: rate.effectiveTo ? isoDate(rate.effectiveTo) : null,
                source: rate.source,
                isActive: rate.isActive,
              }))}
            />
          </div>
        </div>
      ),
    });
  }

  panels.push({
    id: "mora",
    label: "Mora",
    content: (
      <div className="rounded-lg border border-border bg-surface p-5">
        <h2 className="text-base font-semibold text-ink">Umbrales de mora</h2>
        <p className="mt-1 text-sm text-ink-muted">
          {config.thresholds
            ? `Último cambio: ${formatDateTime(config.thresholds.updatedAt, "siempre")}`
            : "Nunca se configuraron: se usan los valores de la especificación."}
        </p>
        <div className="mt-4">
          <ThresholdsForm initial={thresholds} />
        </div>
      </div>
    ),
  });

  panels.push({
    id: "canales",
    label: "Canales de pago",
    content: (
      <div className="rounded-lg border border-border bg-surface p-5">
        <h2 className="text-base font-semibold text-ink">Canales de pago</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Los datos que ve el cliente al pagar, y si el canal ya recibió los datos reales de la
          cuenta. Marcar un canal como demo es irreversible desde aquí.
        </p>
        <div className="mt-4">
          <ChannelForms
            channels={config.channels.map((channel) => ({
              id: channel.id,
              name: channel.name,
              instructionsText: channel.instructionsText,
              isActive: channel.isActive,
              isDemoData: channel.isDemoData,
              legalReview: channel.legalReview,
              meta: (channel.meta ?? {}) as Record<string, unknown>,
            }))}
          />
        </div>
      </div>
    ),
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Configuración</h1>
        <p className="text-sm text-ink-muted">
          Escribes el motivo una vez y lo usan todos los cambios de esta tanda. Los préstamos ya
          aprobados conservan las condiciones con las que se crearon.
        </p>
      </div>

      <ConfigWorkspace panels={panels} />
    </div>
  );
}