"use client";

import { useId, useState } from "react";
import { Button, Input } from "@/components/ui";
import {
  BatchReasonNote,
  ConfigError,
  SaveButton,
  parseWholeNumber,
  useConfigSave,
} from "./config-form-parts";
import { TermFrequency } from "@/server/types";

const FREQUENCIES: Array<{ value: TermFrequency; label: string }> = [
  { value: TermFrequency.WEEKLY, label: "Semanal" },
  { value: TermFrequency.BIWEEKLY, label: "Quincenal" },
  { value: TermFrequency.MONTHLY, label: "Mensual" },
];

export interface ProductTermsFormProps {
  productCode: string;
  initial: {
    name: string;
    termFrequency: TermFrequency;
    termInstallments: number;
    minTermInstallments: number;
    maxTermInstallments: number;
    effectiveFeeBps: number;
    isActive: boolean;
  };
}

/**
 * Términos del producto (F13-2b) — `PATCH /api/admin/config/products/:code`.
 *
 * Solo cambia lo que afecta a las **solicitudes futuras**. Cada préstamo guarda su snapshot en
 * `loans.pricing`, así que tocar la tarifa o el plazo no altera lo que ya se cobró; el formulario
 * lo dice en pantalla para que nadie espere un retroactivo.
 *
 * `termInstallments` debe quedar entre el mínimo y el máximo, y el servidor lo comprueba también —
 * la validación del cliente está para el mensaje inmediato, no como garantía.
 */
export function ProductTermsForm({ productCode, initial }: ProductTermsFormProps) {
  const { save, pending, error } = useConfigSave();
  const id = useId();
  const [name, setName] = useState(initial.name);
  const [frequency, setFrequency] = useState<TermFrequency>(initial.termFrequency);
  const [installments, setInstallments] = useState(String(initial.termInstallments));
  const [minInstallments, setMinInstallments] = useState(String(initial.minTermInstallments));
  const [maxInstallments, setMaxInstallments] = useState(String(initial.maxTermInstallments));
  const [feeBps, setFeeBps] = useState(String(initial.effectiveFeeBps));
const [isActive, setIsActive] = useState(initial.isActive);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);

    const values = {
      termInstallments: parseWholeNumber(installments),
      minTermInstallments: parseWholeNumber(minInstallments),
      maxTermInstallments: parseWholeNumber(maxInstallments),
      effectiveFeeBps: parseWholeNumber(feeBps),
    };
    const bad = Object.entries(values).find(([, value]) => value === null);
    if (bad) {
      setLocalError(`"${bad[0]}" debe ser un número entero.`);
      return;
    }
    const {
      termInstallments: term,
      minTermInstallments: min,
      maxTermInstallments: max,
      effectiveFeeBps: fee,
    } = values as {
      termInstallments: number;
      minTermInstallments: number;
      maxTermInstallments: number;
      effectiveFeeBps: number;
    };
    if (min > max) {
      setLocalError(`El plazo mínimo (${min}) no puede ser mayor que el máximo (${max}).`);
      return;
    }
    if (term < min || term > max) {
      setLocalError(`Las cuotas (${term}) deben estar entre ${min} y ${max}.`);
      return;
    }
    if (fee < 0 || fee > 10_000) {
      setLocalError("La tarifa efectiva va de 0 a 10.000 puntos básicos (0 % a 100 %).");
      return;
    }

    await save({
      url: `/api/admin/config/products/${encodeURIComponent(productCode)}`,
      method: "PATCH",
      body: { name, termFrequency: frequency, ...values, isActive },
      successTitle: "Producto actualizado",
successDescription: `Los términos de ${productCode} aplican a las solicitudes siguientes.`,
    });
  };

  const shown = localError ?? error;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Input
        id={`${id}-name`}
        label="Nombre del producto"
        value={name}
        disabled={pending}
        onChange={(event) => setName(event.target.value)}
      />

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium text-ink">Periodicidad del pago</legend>
        <div className="flex flex-wrap gap-2">
          {FREQUENCIES.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={frequency === option.value ? "primary" : "secondary"}
              size="sm"
              disabled={pending}
              aria-pressed={frequency === option.value}
              onClick={() => setFrequency(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          id={`${id}-min`}
          label="Cuotas mínimas"
          inputMode="numeric"
          value={minInstallments}
          disabled={pending}
          onChange={(event) => setMinInstallments(event.target.value)}
        />
        <Input
          id={`${id}-term`}
          label="Cuotas por defecto"
          inputMode="numeric"
          value={installments}
          disabled={pending}
          onChange={(event) => setInstallments(event.target.value)}
        />
        <Input
          id={`${id}-max`}
          label="Cuotas máximas"
          inputMode="numeric"
          value={maxInstallments}
          disabled={pending}
          onChange={(event) => setMaxInstallments(event.target.value)}
        />
      </div>

      <Input
        id={`${id}-fee`}
        label="Tarifa efectiva (puntos básicos)"
        hint="2400 = 24,00 %"
        inputMode="numeric"
        value={feeBps}
        disabled={pending}
        onChange={(event) => setFeeBps(event.target.value)}
      />

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant={isActive ? "secondary" : "success"}
          size="sm"
          disabled={pending}
          aria-pressed={isActive}
          onClick={() => setIsActive((value) => !value)}
        >
          {isActive ? "Activo — pulsar para desactivar" : "Inactivo — pulsar para activar"}
        </Button>
      </div>

      <BatchReasonNote />

      <div className="flex flex-col gap-2">
        <SaveButton pending={pending} disabled={name.trim().length < 2}>
          Guardar términos
        </SaveButton>
        <ConfigError error={shown} />
      </div>
    </form>
  );
}