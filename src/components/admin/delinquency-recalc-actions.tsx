"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@/components/ui";

/**
 * Botón de recálculo de mora (F11). Es la **escritura explícita** de la caché: la pantalla de
 * `/admin/mora` siempre muestra el recálculo al vuelo, así que este botón no es para "refrescar lo
 * que veo", sino para dejar el dato guardado en `loans` (lo que luego leen los filtros de otras
 * pantallas y las métricas de cartera) y para disparar los avisos de cuota.
 *
 * Después de recargar avisa con un resumen en texto: "17 revisados, 3 actualizados, 2 avisos
 * nuevos". Un admin tiene que poder distinguir "no cambió nada" de "no se pudo leer nada" sin abrir
 * la consola.
 */

interface RecalcPortfolioResponse {
  summary?: {
    evaluated: number;
    updated: number;
    notificationsCreated: number;
    failed: Array<{ loanId: string; reason: string }>;
  };
  loan?: { id: string; changed: boolean };
  error?: { message?: string };
}

function readErrorMessage(response: Response): string {
  return `No se pudo recalcular (HTTP ${response.status}).`;
}

export function DelinquencyRecalcActions() {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/delinquency/recalc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await response.json().catch(() => ({}))) as RecalcPortfolioResponse;
      if (!response.ok || !body.summary) {
        setError(body.error?.message ?? readErrorMessage(response));
        return;
      }

      const { evaluated, updated, notificationsCreated, failed } = body.summary;
      const partes = [
        `${evaluated} préstamo${evaluated === 1 ? "" : "s"} revisado${evaluated === 1 ? "" : "s"}`,
        `${updated} con la caché actualizada`,
        `${notificationsCreated} aviso${notificationsCreated === 1 ? "" : "s"} nuevo${
          notificationsCreated === 1 ? "" : "s"
        }`,
      ];
      if (failed.length > 0) {
        partes.push(`${failed.length} sin poder calcular`);
      }
      toast(
        failed.length > 0 ? "info" : "success",
        "Recálculo de mora",
        `${partes.join(" · ")}.`,
      );
      router.refresh();
    } catch (cause) {
      setError(
        `No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo: ${
          cause instanceof Error ? cause.message : "error desconocido"
        }`,
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <Button variant="secondary" onClick={run} loading={pending}>
        Recalcular cartera
      </Button>
      {error ? (
        <p role="alert" className="max-w-sm text-right text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function LoanRecalcButton({ loanId, loanNumber }: { loanId: string; loanNumber: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  const run = async () => {
    setPending(true);
    try {
      const response = await fetch("/api/admin/delinquency/recalc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanId }),
      });
      const body = (await response.json().catch(() => ({}))) as RecalcPortfolioResponse;
      if (!response.ok) {
        toast("danger", "No se pudo recalcular", body.error?.message ?? readErrorMessage(response));
        return;
      }
      toast(
        "success",
        "Mora recalculada",
        body.loan?.changed
          ? `${loanNumber} quedó guardado con su estado y sus días de atraso.`
          : `${loanNumber} ya estaba al día con la caché guardada.`,
      );
      router.refresh();
    } catch {
      toast("danger", "No se pudo recalcular", "Sin conexión con el servidor. Intenta de nuevo.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Button variant="ghost" size="sm" onClick={run} loading={pending}>
      Recalcular
    </Button>
  );
}
