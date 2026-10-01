"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { formatPesos } from "@/server/money";
import { formatRateBps, formatRateBpsPrecise } from "@/lib/credit-labels";

interface TierOption {
  position: number;
  amountPesos: number;
  minScore?: number;
  isActive: boolean;
}

interface Product {
  code: string;
  name: string;
  termInstallments: number;
  termFrequency: string;
  minTermInstallments: number;
  maxTermInstallments: number;
  effectiveFeeBps: number;
  tiers: TierOption[];
}

interface LoanQuote {
  productId: string;
  amountPesos: number;
  termInstallments: number;
  termFrequency: string;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  totalPayablePesos: number;
  monthlyInstallmentPesos: number;
  annualRateBps: number;
  effectiveFeeBps: number;
  /** Tasa por periodo de pago, que es la que se cobra en el calendario. */
  periodRateBps: number;
  /** Equivalente mensual (anual / 12), para comparar entre productos. */
  monthlyRateBps: number;
  installments: { installmentNumber: number; dueDateIso: string; totalPesos: number }[];
}

interface LoanApplicationFormProps {
  userId: string;
}

const frequencyLabel = (freq: string) => {
  switch (freq) {
    case "WEEKLY":
      return "Semanal";
    case "BIWEEKLY":
      return "Quincenal";
    case "MONTHLY":
      return "Mensual";
    default:
      return freq;
  }
};

/**
 * Cómo se llama la cuota según la frecuencia del producto. En semanal o quincenal, llamar
 * "cuota mensual" a lo que se paga cada semana es el mismo error que llamar "mensual" a la tasa.
 */
const CUOTA_LABEL: Record<string, string> = {
  WEEKLY: "Cuota semanal",
  BIWEEKLY: "Cuota quincenal",
  MONTHLY: "Cuota mensual",
};

const formatDueDate = (iso: string) => {
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  return new Intl.DateTimeFormat("es-CO", options).format(new Date(iso));
};

export function LoanApplicationForm({ userId }: LoanApplicationFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [product, setProduct] = useState<Product | null>(null);
  const [selectedTier, setSelectedTier] = useState<TierOption | null>(null);
  const [selectedTerm, setSelectedTerm] = useState<number>(0);
  const [quote, setQuote] = useState<LoanQuote | null>(null);
  const [isQuoteLoading, setIsQuoteLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadProduct = async () => {
      try {
        const res = await fetch("/api/credit-products");
        if (!res.ok) throw new Error("No se pudo cargar el producto");
        const data = await res.json();
        if (!cancelled && data.products?.length > 0) {
          const p = data.products[0];
          const min = p.minTermInstallments ?? 2;
          const max = p.maxTermInstallments ?? 6;
          const defaultTerm = Math.min(Math.max(p.termInstallments, min), max);
          setProduct({
            code: p.code ?? p.id,
            name: p.name,
            termInstallments: p.termInstallments,
            termFrequency: p.termFrequency,
            minTermInstallments: min,
            maxTermInstallments: max,
            effectiveFeeBps: p.effectiveFeeBps,
            tiers: p.tiers ?? [],
          });
          const activeTier = p.tiers?.find((t: TierOption) => t.isActive && t.position === 1);
          if (activeTier) setSelectedTier(activeTier);
          setSelectedTerm(defaultTerm);
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) setError("Error al cargar la información del producto");
      }
    };
    loadProduct();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadQuote = useCallback(async () => {
    if (!product || !selectedTier || !selectedTerm) return;
    setIsQuoteLoading(true);
    try {
      const res = await fetch(
        `/api/credit-products/quote?productId=${encodeURIComponent(product.code)}&amountPesos=${selectedTier.amountPesos}&termInstallments=${selectedTerm}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "No se pudo calcular el plan");
      setQuote(data.quote as LoanQuote);
    } catch (err) {
      console.error(err);
      setQuote(null);
    } finally {
      setIsQuoteLoading(false);
    }
  }, [product, selectedTier, selectedTerm]);

  useEffect(() => {
    if (!product || !selectedTier || !selectedTerm) return;
    const timer = window.setTimeout(loadQuote, 200);
    return () => window.clearTimeout(timer);
  }, [loadQuote, product, selectedTier, selectedTerm]);

  const termOptions = useMemo(() => {
    if (!product) return [];
    const options = [];
    for (let n = product.minTermInstallments; n <= product.maxTermInstallments; n++) {
      options.push(n);
    }
    return options;
  }, [product]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTier || !product || !selectedTerm) return;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/loan-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: product.code,
          requestedAmountPesos: selectedTier.amountPesos,
          termInstallments: selectedTerm,
          termFrequency: product.termFrequency,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || "Error al crear la solicitud");
      }

      toast("success", "Solicitud creada", "Tu solicitud ha sido creada como borrador. Puedes presentarla cuando estés listo.");
      router.push("/mis-solicitudes");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-lg">Nueva solicitud de préstamo</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <div className="p-4 rounded-md bg-danger-bg text-danger text-sm" role="alert">
            {error}
          </div>
        )}

        {product && (
          <form onSubmit={handleSubmit}>
            <div className="space-y-2 p-4 rounded-lg bg-surface-muted border border-border">
              <h3 className="font-medium text-ink">{product.name}</h3>
              <dl className="grid grid-cols-2 gap-2 text-sm mt-2">
                <dt className="text-ink-muted">Frecuencia</dt>
                <dd className="text-ink font-medium">
                  {frequencyLabel(product.termFrequency)}
                </dd>
                <dt className="text-ink-muted">Tasa efectiva</dt>
                <dd className="text-ink font-medium">
                  {(product.effectiveFeeBps / 100).toFixed(2)}%
                </dd>
              </dl>
            </div>

            <fieldset className="space-y-3">
              <legend className="font-medium text-ink">Selecciona tu monto (según tu tier elegible)</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {product.tiers
                  .filter((t) => t.isActive)
                  .sort((a, b) => a.position - b.position)
                  .map((tier) => (
                    <label
                      key={tier.position}
                      className={`relative cursor-pointer p-4 rounded-lg border-2 transition-colors ${
                        selectedTier?.position === tier.position
                          ? "border-primary-600 bg-primary-50"
                          : "border-border hover:border-primary-300"
                      }`}
                    >
                      <input
                        type="radio"
                        name="tier"
                        value={tier.position.toString()}
                        checked={selectedTier?.position === tier.position}
                        onChange={() => setSelectedTier(tier)}
                        className="sr-only"
                      />
                      <div className="flex flex-col items-start">
                        <span className="text-xs text-ink-muted">Tier {tier.position}</span>
                        <span className="text-xl font-bold text-ink">
                          {formatPesos(tier.amountPesos)}
                        </span>
                        {tier.minScore && (
                          <span className="text-xs text-ink-muted">Score mínimo: {tier.minScore}</span>
                        )}
                      </div>
                    </label>
                  ))}
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="font-medium text-ink">
                Elige a cuántas cuotas pagar ({frequencyLabel(product.termFrequency).toLowerCase()})
              </legend>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {termOptions.map((n) => (
                  <label
                    key={n}
                    className={`relative cursor-pointer p-3 rounded-lg border-2 transition-colors flex flex-col items-start ${
                      selectedTerm === n
                        ? "border-primary-600 bg-primary-50"
                        : "border-border hover:border-primary-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="term"
                      value={n.toString()}
                      checked={selectedTerm === n}
                      onChange={() => setSelectedTerm(n)}
                      className="sr-only"
                    />
                    <span className="text-xl font-bold text-ink">{n}</span>
                    <span className="text-xs text-ink-muted">cuotas</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <section
              aria-live="polite"
              className="mt-4 p-4 rounded-lg border border-border bg-surface space-y-2"
            >
              <h3 className="font-medium text-ink">Así quedará tu plan (estimado)</h3>
              {isQuoteLoading || !quote ? (
                <p className="text-sm text-ink-muted">
                  {isQuoteLoading ? "Calculando tu plan…" : "Elige tu monto y cuotas para ver el plan."}
                </p>
              ) : (
                <>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
<dt className="text-ink-muted">{CUOTA_LABEL[quote.termFrequency]}</dt>
                      <dd className="text-ink font-semibold">
                        {formatPesos(quote.monthlyInstallmentPesos)}
                      </dd>
                    <dt className="text-ink-muted">Total a pagar</dt>
                    <dd className="text-ink font-semibold">{formatPesos(quote.totalPayablePesos)}</dd>
                    <dt className="text-ink-muted">N° de pagos</dt>
                    <dd className="text-ink font-semibold">{quote.termInstallments}</dd>
                    <dt className="text-ink-muted">Primera cuota aprox.</dt>
                    <dd className="text-ink font-semibold">
                      {formatDueDate(quote.installments[0].dueDateIso)}
                    </dd>
                  </dl>

                  {/* Tasa: primero la que se cobra, después el desglose. Publicar solo la cuota
                      hacía que el precio final pareciera arbitrario. */}
                  <div className="rounded-lg border border-border bg-surface-muted p-3">
                    <p className="text-sm text-ink-muted">
                      Tasa de interés{" "}
                      <span className="font-semibold text-ink">
                        {formatRateBpsPrecise(quote.monthlyRateBps)} mensual
                      </span>
                      {quote.termFrequency === "MONTHLY" ? null : (
                        <span className="block text-xs font-normal text-ink-muted">
                          Equivalente mensual de la tasa anual; en este producto cobras{" "}
                          {formatRateBpsPrecise(quote.periodRateBps)} por cada{" "}
                          {quote.termFrequency === "WEEKLY" ? "semana" : "quincena"}.
                        </span>
                      )}
                    </p>
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <dt className="text-ink-muted">Tasa anual</dt>
                      <dd className="tabular-nums text-ink">
                        {formatRateBps(quote.annualRateBps)}
                      </dd>
                      <dt className="text-ink-muted">Tarifa (pago único)</dt>
                      <dd className="tabular-nums text-ink">
                        {formatRateBpsPrecise(quote.effectiveFeeBps)} ·{" "}
                        {formatPesos(quote.feePesos)}
                      </dd>
                    </dl>
                  </div>

                  <p className="text-xs text-ink-muted">
                    La tasa mensual es la anual dividida entre 12; tu cuota{" "}
                    {quote.termFrequency === "MONTHLY" ? "" : "no es "}incluye la tarifa, que se
                    cobra una sola vez sobre el capital. Los pesos se confirman al aprobar tu
                    solicitud; las fechas son estimadas.
                  </p>
                </>
              )}
            </section>

            <div className="p-4 rounded-lg bg-info-bg border border-info text-sm text-info mt-4">
              <p className="font-medium">Nota importante:</p>
              <ul className="list-disc list-inside mt-1 space-y-1">
                <li>El monto se asigna automáticamente según tu historial crediticio.</li>
                <li>No puedes solicitar un monto diferente al de tu tier elegible.</li>
                <li>Solo puedes tener un préstamo activo a la vez.</li>
              </ul>
            </div>

            <Button type="submit" disabled={isLoading || !selectedTier || !selectedTerm || !product} className="w-full">
              {isLoading ? "Creando solicitud..." : "Crear solicitud (borrador)"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}