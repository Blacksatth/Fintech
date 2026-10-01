"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, useToast } from "@/components/ui";

interface LimitResponse {
  limit?: { userId?: string };
  error?: { message?: string };
}

/**
 * Formulario por fila para ajustar el límite de crédito de un cliente (F13-2a).
 *
 * Llama a `POST /api/admin/users/:uid/limit`; la operación es idempotente por clave `{uid}`, así
 * que un doble clic no duplica nada. El texto de la acción describe SIEMPRE lo que hace (nunca
 * solo color): "Guardar límite" / "Quitar".
 */
export function UserLimitForm({
  uid,
  currentLimitPesos,
}: {
  uid: string;
  currentLimitPesos: number | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [value, setValue] = useState(currentLimitPesos ? String(currentLimitPesos) : "");
  const [pending, setPending] = useState<null | "set" | "clear">(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (mode: "set" | "clear") => {
    setError(null);
    if (mode === "set") {
      const parsed = value.trim();
      if (!/^\d+$/.test(parsed)) {
        setError("El límite debe ser un número entero en pesos.");
        return;
      }
      const amount = Number(parsed);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        setError("El límite debe ser un entero mayor que cero.");
        return;
      }
    }

    setPending(mode);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(uid)}/limit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "set" ? { creditLimitPesos: Number(value.trim()) } : { creditLimitPesos: null },
        ),
      });
      const body = (await response.json().catch(() => ({}))) as LimitResponse;
      if (!response.ok) {
        setError(body.error?.message ?? `No se pudo ajustar el límite (HTTP ${response.status}).`);
        return;
      }
      toast(
        "success",
        "Límite actualizado",
        mode === "set"
          ? `${uid} puede pedir hasta ${value.trim()} COP.`
          : `Se quitó el límite manual de ${uid}.`,
      );
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo.");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-end gap-2">
        <Input
          label="Límite en pesos"
          hideLabel
          prefix="$"
          inputMode="numeric"
          placeholder="Sin límite manual"
          value={value}
          disabled={pending !== null}
          onChange={(event) => setValue(event.target.value)}
          className="w-36"
        />
        <Button variant="secondary" size="sm" onClick={() => submit("set")} loading={pending === "set"}>
          Guardar
        </Button>
        {currentLimitPesos !== null ? (
          <Button variant="ghost" size="sm" onClick={() => submit("clear")} loading={pending === "clear"}>
            Quitar
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="max-w-xs text-right text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}