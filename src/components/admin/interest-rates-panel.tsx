"use client";

import { useId, useState } from "react";
import { Badge, Button, Input } from "@/components/ui";
import {
  ConfigError,

  BatchReasonNote,
  parseWholeNumber,
  useConfigSave,
} from "./config-form-parts";

export interface RateRow {
  id: string;
  version: number;
  annualRateBps: number;
  maximumRateBps: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  isActive: boolean;
}

/** Puntos básicos → porcentaje legible: 2400 → "24,00 %". */
function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(".", ",")} %`;
}

function ActivateToggle({ rate }: { rate: RateRow }) {
  const { save, pending, error } = useConfigSave();
  const id = useId();

  const toggle = async (isActive: boolean) => {
await save({
      url: `/api/admin/config/rates/${encodeURIComponent(rate.id)}`,
      method: "PATCH",
      body: { isActive },
      successTitle: isActive ? `Tasa v${rate.version} activada` : `Tasa v${rate.version} desactivada`,
      successDescription: `${bpsToPercent(rate.annualRateBps)} desde ${rate.effectiveFrom}`,
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => void toggle(!rate.isActive)}
      >
        {rate.isActive ? "Desactivar" : "Activar"}
      </Button>
      <BatchReasonNote />
      <ConfigError error={error} />
    </div>
  );
}

function NewVersionForm({ productType }: { productType: string }) {
  const { save, pending, error } = useConfigSave();
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const [annualBps, setAnnualBps] = useState("");
  const [maxBps, setMaxBps] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [source, setSource] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);

    const annual = parseWholeNumber(annualBps);
    if (annual === null || annual < 0 || annual > 100_000) {
      setLocalError("La tasa anual va de 0 a 100.000 puntos básicos (0 % a 1.000 %).");
      return;
    }
    const max = maxBps.trim() === "" ? null : parseWholeNumber(maxBps);
    if (maxBps.trim() !== "" && (max === null || max < annual)) {
      setLocalError("La tasa máxima legal no puede ser menor que la tasa que se publica.");
      return;
    }
    if (source.trim().length < 3) {
      setLocalError("Indica la fuente de la tasa (resolución, acuerdo, tabla).");
      return;
    }

    const saved = await save({
      url: "/api/admin/config/rates",
      method: "POST",
      body: {
        productType,
        annualRateBps: annual,
        maximumRateBps: max,
        effectiveFrom,
        source: source.trim(),
      },
      successTitle: "Tasa publicada",
      successDescription: `${bpsToPercent(annual)} desde el ${effectiveFrom}. Los préstamos ya aprobados conservan su tasa.`,
      // La versión se reserva leyendo el máximo dentro de la transacción: sin clave, un doble clic
      // publicaría dos versiones idénticas.
      idempotent: true,
    });
if (saved) {
      setAnnualBps("");
      setMaxBps("");
      setSource("");
    }
  };

  const shown = localError ?? error;

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm font-medium text-ink">Publicar una versión nueva</p>
      <p className="text-xs text-ink-muted">
        Publicar no edita: crea la versión siguiente y deja intactas las anteriores, que son el
        registro de lo que aceptó cada cliente.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Input
          id={`${id}-annual`}
          label="Tasa anual (pb)"
          hint="2400 = 24,00 %"
          inputMode="numeric"
          value={annualBps}
          disabled={pending}
          onChange={(event) => setAnnualBps(event.target.value)}
        />
        <Input
          id={`${id}-max`}
          label="Tasa máxima legal (pb)"
          hint="Opcional"
          inputMode="numeric"
          value={maxBps}
          disabled={pending}
          onChange={(event) => setMaxBps(event.target.value)}
        />
        <Input
          id={`${id}-from`}
          label="Vigente desde"
          type="date"
          value={effectiveFrom}
          disabled={pending}
          onChange={(event) => setEffectiveFrom(event.target.value)}
        />
        <Input
          id={`${id}-source`}
          label="Fuente"
          placeholder="Resolución 123 de 2026"
          value={source}
          disabled={pending}
          onChange={(event) => setSource(event.target.value)}
        />
      </div>
      <BatchReasonNote />
      <div className="flex flex-col gap-2">
        <Button type="submit" size="sm" loading={pending}>
          Publicar versión
        </Button>
        <ConfigError error={shown} />
      </div>
    </form>
  );
}

/**
 * Historial de tasas del producto (F13-2b).
 *
 * lo editable es si cada versión está activa; los importes no. Publicar una versión nueva es el
 * único camino para cambiar la tasa, y por eso el alta está separada del resto de la fila: mezclarlas
 * invitaría a editar el número que aceptó un préstamo concreto.
 */
export function InterestRatesPanel({ productType, rates }: { productType: string; rates: RateRow[] }) {
  return (
    <div className="flex flex-col gap-4">
      {rates.length === 0 ? (
        <p className="text-sm text-ink-muted">
          Este producto no tiene tasas publicadas. No se puede originar ningún préstamo hasta
          publicar la primera.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rates.map((rate) => (
            <li key={rate.id} className="flex flex-col gap-1 border-b border-border pb-3 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">Versión {rate.version}</span>
                <Badge tone={rate.isActive ? "success" : "neutral"}>
                  {rate.isActive ? "Activa" : "Inactiva"}
                </Badge>
                <span className="text-sm font-semibold tabular-nums text-ink">
                  {bpsToPercent(rate.annualRateBps)}
                </span>
                {rate.maximumRateBps !== null ? (
                  <span className="text-xs text-ink-subtle">
                    máx. legal {bpsToPercent(rate.maximumRateBps)}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-ink-muted">
                Vigente desde {rate.effectiveFrom}
                {rate.effectiveTo ? ` hasta ${rate.effectiveTo}` : " sin fecha de cierre"} ·{" "}
                {rate.source}
              </p>
              <ActivateToggle rate={rate} />
            </li>
          ))}
        </ul>
      )}

      <NewVersionForm productType={productType} />
    </div>
  );
}