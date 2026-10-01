"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, useToast } from "@/components/ui";
import { useBatchReason } from "./batch-reason";

/**
 * Piezas compartidas por los formularios de configuración (F13-2b).
 *
 * Las cinco secciones de `/admin/configuracion` hacen lo mismo —validar, pedir el motivo, llamar a
 * un PATCH/POST, avisar y refrescar— y cada una repetirlo era la forma segura de que una se
 * quedara sin manejo de error o sin `router.refresh()`, que son justo los dos fallos que no se ven
 * hasta que el admin guarda y la pantalla no cambia.
 */

interface ApiErrorBody {
  error?: { message?: string };
}

/**
 * Guarda una mutación de configuración y centraliza sus tres obligaciones: el motivo es obligatorio,
 * el error del servidor se muestra tal cual y la pantalla se refresca después de guardar.
 *
 * `Idempotency-Key` se genera **por intento**, no por montaje: la clave identifica "esta operación
 * concreta", y reutilizarla tras un error de red dejaría al admin esperando un guardado que nunca
 * ocurrió. Se genera con `crypto.randomUUID()` cuando el navegador lo tiene y con una mezcla de
 * `Math.random()` cuando no (contexto no seguro), porque la clave solo tiene que ser única entre
 * las peticiones de esta sesión, no criptográfica.
 */
export function useConfigSave(): {
  save: (input: {
    url: string;
    method: "POST" | "PATCH";
    body: Record<string, unknown>;
    successTitle: string;
    successDescription: string;
    /** Endpoint que crea y por tanto exige `Idempotency-Key`. */
    idempotent?: boolean;
  }) => Promise<boolean>;
  pending: boolean;
  error: string | null;
  clearError: () => void;
} {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { reason, registerSave } = useBatchReason();

  const save = useCallback(
    async (input: {
      url: string;
      method: "POST" | "PATCH";
      body: Record<string, unknown>;
      successTitle: string;
      successDescription: string;
      idempotent?: boolean;
    }): Promise<boolean> => {
      const motivo = reason.trim();
      if (motivo.length < 3) {
        setError("Falta el motivo de la tanda: escríbelo arriba (mínimo 3 letras). Sin él no hay auditoría.");
        return false;
      }

      setError(null);
      setPending(true);
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers: {
            "Content-Type": "application/json",
            ...(input.idempotent ? { "Idempotency-Key": newIdempotencyKey() } : {}),
          },
          body: JSON.stringify({ ...input.body, reason: motivo }),
        });
        const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
        if (!response.ok) {
          setError(body.error?.message ?? `No se pudo guardar el cambio (HTTP ${response.status}).`);
          return false;
        }
        registerSave();
        toast("success", input.successTitle, input.successDescription);
        router.refresh();
        return true;
      } catch {
        setError("No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo.");
        return false;
      } finally {
        setPending(false);
      }
    },
    [reason, registerSave, router, toast],
  );

  return { save, pending, error, clearError: () => setError(null) };
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Recordatorio del motivo heredado, para cada formulario de configuración.
 *
 * Cada sección ya no pide el motivo (se escribe una vez en la barra de arriba), pero sí dice con qué
 * motivo se va a guardar: si el campo de arriba está vacío, esto es lo único que le avisa al admin
 * antes de apretar Guardar.
 */
export function BatchReasonNote() {
  const { reason } = useBatchReason();
  const motivo = reason.trim();

  return (
    <p data-slot="batch-reason-note" className="text-xs text-ink-muted">
      {motivo.length >= 3 ? (
        <>
          Se guardará con el motivo de la tanda:{" "}
          <span className="font-medium text-ink">«{motivo}»</span>
        </>
      ) : (
        <>
          Falta el motivo de la tanda:{" "}
          <span className="font-medium text-warning">escríbelo arriba</span> para poder guardar,{" "}
          porque la auditoría lo necesita.
        </>
      )}
    </p>
  );
}

/** Mensaje de error del servidor, con `role="alert"` para que un lector de pantalla lo lea. */
export function ConfigError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      {error}
    </p>
  );
}

/** Botón de guardar con el estado de carga del formulario. */
export function SaveButton({
  pending,
  children,
  disabled,
}: {
  pending: boolean;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Button type="submit" loading={pending} disabled={disabled}>
      {children}
    </Button>
  );
}

/** Campo numérico que se niega a enviar algo que no sea un entero. */
export function parseWholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** Montos en pesos: solo dígitos, sin signo ni separador (el formateo es de `formatPesos`). */
export function isPesosAmount(raw: string): boolean {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)) && Number(trimmed) > 0;
}