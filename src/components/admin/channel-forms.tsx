"use client";

import { useId, useState } from "react";
import { Badge, Button, Input, Textarea } from "@/components/ui";
import { PaymentChannelType } from "@/server/payment-doc";
import { ConfigError,
 BatchReasonNote, useConfigSave } from "./config-form-parts";
import { PUBLIC_META_KEYS, PUBLIC_META_LABELS } from "@/lib/public-meta-labels";

export interface ChannelRow {
  id: string;
  name: string;
  instructionsText: string;
  isActive: boolean;
  isDemoData: boolean;
  legalReview: string | null;
  meta: Record<string, unknown>;
}

/**
 * Los tres estados del marcador legal del canal. No es un interruptor porque no son dos: hay un
 * tercer estado —"sigue siendo el que estaba"— que es el que se usa el 90 % de las veces (cambiar
 * el texto de instrucción no debería tocar la advertencia legal).
 */
type DataReplacedChoice = "keep" | "real" | "demo";

const CHOICES: Array<{ value: DataReplacedChoice; label: string }> = [
  { value: "keep", label: "Sin cambio" },
  { value: "real", label: "Ya son datos reales" },
  { value: "demo", label: "Volver a marcar como demo" },
];

function ChannelBody({ channel }: { channel: ChannelRow }) {
  const { save, pending, error } = useConfigSave();
  const id = useId();
  const [name, setName] = useState(channel.name);
  const [instructions, setInstructions] = useState(channel.instructionsText);
  const [isActive, setIsActive] = useState(channel.isActive);
  const [choice, setChoice] = useState<DataReplacedChoice>("keep");
  const [meta, setMeta] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const key of PUBLIC_META_KEYS) {
      const value = channel.meta[key];
      if (typeof value === "string") initial[key] = value;
    }
    return initial;
  });
    const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);

    if (name.trim().length < 3) {
      setLocalError("El nombre del canal necesita al menos 3 caracteres.");
      return;
    }

    const publicMeta: Record<string, string> = {};
    for (const [key, value] of Object.entries(meta)) {
      const trimmed = value.trim();
      // Cadena vacía = quitar el dato. Se manda igual: el servicio borra la clave en vez de
      // guardar "" (que el cliente vería como "tiene el campo pero vacío").
      publicMeta[key] = trimmed;
    }

    await save({
      url: `/api/admin/config/channels/${encodeURIComponent(channel.id)}`,
      method: "PATCH",
      body: {
        name: name.trim(),
        instructionsText: instructions.trim(),
        isActive,
        publicMeta,
        ...(choice === "keep" ? {} : { dataReplaced: choice === "real" }),
      },
      successTitle: `Canal ${channel.name} actualizado`,
      successDescription:
        choice === "real"
          ? "Marcado como datos reales; queda pendiente de revisión legal."
          : choice === "demo"
            ? "Marcado como demostración; no se puede recibir dinero real."
: "Los cambios solo aplican a las nuevas instrucciones.",
    });
  };

  const shown = localError ?? error;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Input
        id={`${id}-name`}
        label="Nombre del canal"
        value={name}
        disabled={pending}
        onChange={(event) => setName(event.target.value)}
      />
      <Textarea
        id={`${id}-instructions`}
        label="Instrucciones de pago"
        hint="Lo que ve el cliente en la pantalla de pagos."
        rows={3}
        value={instructions}
        disabled={pending}
        onChange={(event) => setInstructions(event.target.value)}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-ink">Datos públicos del canal</legend>
        <p className="text-xs text-ink-muted">
          Estos valores se muestran al cliente cuando paga por este canal. Borrar el campo lo quita de
          la pantalla.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {PUBLIC_META_KEYS.map((key) => (
            <Input
              key={key}
              id={`${id}-meta-${key}`}
              label={PUBLIC_META_LABELS[key]}
              value={meta[key] ?? ""}
              disabled={pending}
              onChange={(event) => setMeta((current) => ({ ...current, [key]: event.target.value }))}
            />
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant={isActive ? "secondary" : "success"}
          size="sm"
          disabled={pending}
          aria-pressed={isActive}
          className="self-start"
          onClick={() => setIsActive((value) => !value)}
        >
          {isActive ? "Activo — pulsar para desactivar" : "Inactivo — pulsar para activar"}
        </Button>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium text-ink">¿Ya llegaron los datos reales?</legend>
          <div className="flex flex-wrap gap-2">
            {CHOICES.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={choice === option.value ? "primary" : "secondary"}
                size="sm"
                disabled={pending}
                aria-pressed={choice === option.value}
                onClick={() => setChoice(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-ink-muted">
            {choice === "real"
              ? "Al guardar se quita la marca de demostración y el canal queda pendiente de revisión legal. No se puede deshacer desde aquí: volver atrás es una tarea legal, no un clic."
              : choice === "demo"
                ? "Al guardar el canal vuelve a quedar marcado como demostración, aunque tenga datos escritos."
                : "Guardar la cuenta nueva no borra la advertencia legal por su cuenta."}
          </p>
        </fieldset>
      </div>

      <BatchReasonNote />

      <div className="flex flex-col gap-2">
        <Button type="submit" loading={pending}>
          Guardar canal
        </Button>
        <ConfigError error={shown} />
      </div>
    </form>
  );
}

/**
 * Canales de pago (F13-2b) — `PATCH /api/admin/config/channels/:channelId`.
 *
 * El `type` no se edita porque es el doc ID: cambiarlo crearía otro canal y dejaría los pagos ya
 * registrados apuntando al anterior.
 *
 * Los marcadores legales (`demo`, `legalReview`) **no son un campo editable**: se derivan de la
 * afirmación explícita "¿ya llegaron los datos reales?". Si fueran un campo más, un admin podría
 * marcarse a sí mismo la revisión legal como aprobada; por eso la pantalla solo ofrece las dos
 * afirmaciones honestas y el servicio decide qué hacer con cada una.
 */
export function ChannelForms({ channels }: { channels: ChannelRow[] }) {
  if (channels.length === 0) {
    return <p className="text-sm text-ink-muted">No hay canales de pago configurados.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {channels.map((channel) => (
        <div key={channel.id} className="flex flex-col gap-3 border-b border-border pb-6 last:border-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">{channel.name}</h3>
            <Badge tone={channel.isActive ? "success" : "neutral"}>
              {channel.isActive ? "Activo" : "Inactivo"}
            </Badge>
            {channel.isDemoData ? <Badge tone="warning">Datos de demostración</Badge> : null}
            {channel.legalReview === "DEMO_REPLACED_PENDING_LEGAL_REVIEW" ? (
              <Badge tone="info">Pendiente de revisión legal</Badge>
            ) : null}
            <span className="text-xs text-ink-subtle">
              id: {channel.id} · {channel.id === PaymentChannelType.NEQUI ? "Nequi" : channel.id}
            </span>
          </div>
          <ChannelBody channel={channel} />
        </div>
      ))}
    </div>
  );
}