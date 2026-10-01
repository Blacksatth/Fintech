"use client";

import { useId, useState } from "react";
import { Badge, Button, Input } from "@/components/ui";
import { formatPesos } from "@/server/money";
import {
  ConfigError,

  BatchReasonNote,
  isPesosAmount,
  parseWholeNumber,
  useConfigSave,
} from "./config-form-parts";

export interface TierRow {
  id: string;
  position: number;
  amountPesos: number;
  minScore: number | null;
  isActive: boolean;
}

function RowEditor({
  tier,
  onSaved,
}: {
  tier: TierRow;
  onSaved: () => void;
}) {
  const { save, pending, error } = useConfigSave();
  const id = useId();
  const [amount, setAmount] = useState(String(tier.amountPesos));
const [minScore, setMinScore] = useState(tier.minScore === null ? "" : String(tier.minScore));
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent, isActive: boolean) => {
    event.preventDefault();
    setLocalError(null);

    if (!isPesosAmount(amount)) {
      setLocalError("El monto debe ser un número entero de pesos, mayor que cero.");
      return;
    }
    const score = minScore.trim() === "" ? null : parseWholeNumber(minScore);
    if (minScore.trim() !== "" && (score === null || score < 0 || score > 100)) {
      setLocalError("El puntaje mínimo va de 0 a 100, o déjalo vacío para no exigirlo.");
      return;
    }

    const saved = await save({
      url: `/api/admin/config/tiers/${encodeURIComponent(tier.id)}`,
      method: "PATCH",
      body: { amountPesos: Number(amount.trim()), minScore: score, isActive },
      successTitle: `Tier ${tier.position} actualizado`,
      successDescription: `${formatPesos(Number(amount.trim()))} · ${isActive ? "activo" : "inactivo"}`,
    });
    if (saved) {
      onSaved();
    }
  };

  const shown = localError ?? error;

  return (
    <form onSubmit={(event) => void submit(event, tier.isActive)} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          id={`${id}-amount`}
          label={`Monto del tier ${tier.position}`}
          hideLabel
          prefix="$"
          inputMode="numeric"
          value={amount}
          disabled={pending}
          onChange={(event) => setAmount(event.target.value)}
          className="w-36"
        />
        <Input
          id={`${id}-score`}
          label={`Puntaje mínimo del tier ${tier.position}`}
          hideLabel
          inputMode="numeric"
          placeholder="Sin mínimo"
          value={minScore}
          disabled={pending}
          onChange={(event) => setMinScore(event.target.value)}
          className="w-28"
        />
        <Button type="submit" size="sm" loading={pending}>
          Guardar
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={(event) => void submit(event, !tier.isActive)}
        >
          {tier.isActive ? "Desactivar" : "Activar"}
        </Button>
      </div>
      <BatchReasonNote />
      <ConfigError error={shown} />
    </form>
  );
}

function CreateTierForm({
  productCode,
  nextPosition,
}: {
  productCode: string;
  nextPosition: number;
}) {
  const { save, pending, error } = useConfigSave();
  const id = useId();
  const [position, setPosition] = useState(String(nextPosition));
  const [amount, setAmount] = useState("");
const [minScore, setMinScore] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);

    const parsedPosition = parseWholeNumber(position);
    if (parsedPosition === null || parsedPosition < 1) {
      setLocalError("La posición debe ser un entero mayor que cero.");
      return;
    }
    if (!isPesosAmount(amount)) {
      setLocalError("El monto debe ser un número entero de pesos, mayor que cero.");
      return;
    }
    const score = minScore.trim() === "" ? null : parseWholeNumber(minScore);
    if (minScore.trim() !== "" && (score === null || score < 0 || score > 100)) {
      setLocalError("El puntaje mínimo va de 0 a 100, o déjalo vacío.");
      return;
    }

const saved = await save({
      url: "/api/admin/config/tiers",
      method: "POST",
      body: { productCode, position: parsedPosition, amountPesos: Number(amount.trim()), minScore: score },
      successTitle: "Tier agregado",
      successDescription: `Posición ${parsedPosition} con ${formatPesos(Number(amount.trim()))}.`,
      // El id del tier es `{código}_{posición}`: sin clave, un doble clic escribiría dos veces
      // sobre el mismo documento.
      idempotent: true,
    });
    if (saved) {
      setAmount("");
      setMinScore("");
    }
  };

  const shown = localError ?? error;

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm font-medium text-ink">Agregar un rung a la escalera</p>
      <p className="text-xs text-ink-muted">
        El monto debe ser mayor que el del rung anterior: el motor elige el tier por historial y baja
        al mayor monto que quepa en el límite del cliente.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Input
          id={`${id}-position`}
          label="Posición"
          inputMode="numeric"
          value={position}
          disabled={pending}
          onChange={(event) => setPosition(event.target.value)}
          className="w-24"
        />
        <Input
          id={`${id}-amount`}
          label="Monto en pesos"
          prefix="$"
          inputMode="numeric"
          value={amount}
          disabled={pending}
          onChange={(event) => setAmount(event.target.value)}
          className="w-36"
        />
        <Input
          id={`${id}-score`}
          label="Puntaje mínimo"
          inputMode="numeric"
          placeholder="Sin mínimo"
          value={minScore}
          disabled={pending}
          onChange={(event) => setMinScore(event.target.value)}
          className="w-28"
        />
        <Button type="submit" size="sm" loading={pending}>
          Agregar tier
        </Button>
      </div>
      <BatchReasonNote />
      <ConfigError error={shown} />
    </form>
  );
}

/**
 * Escalera de montos del producto (F13-2b).
 *
 * Una fila por rung, editable en su sitio, y el alta de un rung nuevo al final.
 *
 * Cada fila pide su propio motivo porque cada guardado es una entrada de auditoría distinta: un
 * motivo compartido por varias filas se contradiría a la primera que cambie.
 */
export function TierEditor({ productCode, tiers }: { productCode: string; tiers: TierRow[] }) {
  const nextPosition = tiers.reduce((max, tier) => Math.max(max, tier.position), 0) + 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4">
        {tiers.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Este producto no tiene tiers. Sin al menos uno activo no se pueden solicitar préstamos.
          </p>
        ) : (
          tiers.map((tier) => (
            <div key={tier.id} className="flex flex-col gap-1 border-b border-border pb-3 last:border-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink">Posición {tier.position}</span>
                <Badge tone={tier.isActive ? "success" : "neutral"}>
                  {tier.isActive ? "Activo" : "Inactivo"}
                </Badge>
                {tier.minScore === null ? (
                  <span className="text-xs text-ink-subtle">Sin puntaje mínimo</span>
                ) : (
                  <span className="text-xs text-ink-subtle">Desde puntaje {tier.minScore}</span>
                )}
              </div>
              <RowEditor tier={tier} onSaved={() => undefined} />
            </div>
          ))
        )}
      </div>

      <CreateTierForm productCode={productCode} nextPosition={nextPosition} />
    </div>
  );
}