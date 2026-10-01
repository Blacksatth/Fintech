"use client";

import { useId, useState } from "react";
import { Button, Input } from "@/components/ui";
import { BatchReasonNote, ConfigError, parseWholeNumber, useConfigSave } from "./config-form-parts";

export interface ThresholdsFormProps {
  initial: { dueSoonDays: number; overdueDays: number; defaultDays: number };
}

/**
 * Umbrales de mora (F13-2b) — `PATCH /api/admin/config/thresholds`.
 *
 * Los tres cortes del ciclo del préstamo: cuándo se empieza a avisar, cuándo está vencido y cuándo
 * va a mora.
 *
 * El aviso en pantalla es parte del contrato, no decoración: estos valores no reescriben los préstamos
 * ya evaluados (cada uno guarda su corte en `loans.delinquency`), así que quien los cambie tiene que
 * saber que además hay que correr el recálculo de mora para que los casos abiertos sigan el cambio.
 */
export function ThresholdsForm({ initial }: ThresholdsFormProps) {
  const { save, pending, error } = useConfigSave();
  const id = useId();
  const [dueSoon, setDueSoon] = useState(String(initial.dueSoonDays));
  const [overdue, setOverdue] = useState(String(initial.overdueDays));
  const [defaultDays, setDefaultDays] = useState(String(initial.defaultDays));
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);

    const dueSoonValue = parseWholeNumber(dueSoon);
    const overdueValue = parseWholeNumber(overdue);
    const defaultValue = parseWholeNumber(defaultDays);
    if (dueSoonValue === null || overdueValue === null || defaultValue === null) {
      setLocalError("Los tres cortes deben ser números enteros.");
      return;
    }
    if (dueSoonValue < 0 || overdueValue < 1 || defaultValue < 1) {
      setLocalError("El aviso no puede ser negativo y los otros dos cortes deben ser al menos 1.");
      return;
    }
    if (dueSoonValue >= overdueValue) {
      setLocalError(
        "La ventana de aviso debe cerrar antes del atraso: si no, un préstamo ya vencido se anunciaría como “vence pronto”.",
      );
      return;
    }
    if (overdueValue > defaultValue) {
      setLocalError("La mora tiene que empezar después (o el mismo día) que el vencimiento.");
      return;
    }

    await save({
      url: "/api/admin/config/thresholds",
      method: "PATCH",
      body: {
        dueSoonDays: dueSoonValue,
        overdueDays: overdueValue,
        defaultDays: defaultValue,
      },
successTitle: "Umbrales de mora actualizados",
      successDescription: "El cambio afecta solo a los recálculos futuros.",
    });
  };

  const shown = localError ?? error;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="rounded-lg bg-surface-muted p-3 text-xs text-ink-muted">
        Cambiar estos cortes <strong>no reescribe</strong> los préstamos ya evaluados: cada uno conserva
        el corte con el que se calculó. Para aplicarlo a la cartera abierta hay que correr el recálculo
        de mora.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          id={`${id}-due-soon`}
          label="Avisa “vence pronto” desde"
          hint="días antes del vencimiento"
          inputMode="numeric"
          value={dueSoon}
          disabled={pending}
          onChange={(event) => setDueSoon(event.target.value)}
        />
        <Input
          id={`${id}-overdue`}
          label="Vencido desde"
          hint="días de atraso"
          inputMode="numeric"
          value={overdue}
          disabled={pending}
          onChange={(event) => setOverdue(event.target.value)}
        />
        <Input
          id={`${id}-default`}
          label="En mora desde"
          hint="días de atraso"
          inputMode="numeric"
          value={defaultDays}
          disabled={pending}
          onChange={(event) => setDefaultDays(event.target.value)}
        />
      </div>

      <BatchReasonNote />

      <div className="flex flex-col gap-2">
        <Button type="submit" loading={pending}>
          Guardar umbrales
        </Button>
        <ConfigError error={shown} />
      </div>
    </form>
  );
}