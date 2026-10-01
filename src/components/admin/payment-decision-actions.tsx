"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Modal, Textarea, useToast } from "@/components/ui";
import { formatPesosOrDash } from "@/server/money";
import type { PaymentStatus } from "@/server/types";

/**
 * Decisiones sobre un pago (F10-4, §11): confirmar, rechazar y revertir.
 *
 * Reglas que la UI respeta y que el servidor vuelve a exigir:
 *
 * - **Confirmar y rechazar** solo desde `PENDING`. **Revertir** solo desde `CONFIRMED`, porque
 *   revertir es deshacer un pago que sí se confirmó, no deshacer una revisión.
 * - Rechazar y revertir exigen `reason`: no se toca el dinero de alguien sin escribir por qué, y ese
 *   texto queda en el pago y en la auditoría.
 * - Cada decisión genera su `Idempotency-Key` al abrir el diálogo y la **reutiliza** en los
 *   reintentos: un doble clic o un reintento por red no puede confirmar dos veces el mismo pago.
 * - El comprobante se pide por separado, con su propia URL firmada. Se puede ver sin decidir, y
 *   decidir no requiere abrirlo: el admin puede tener el dinero verificado en su banco.
 */

const MAX_REASON_LENGTH = 500;

type Decision = "confirm" | "reject" | "reverse";

export interface PaymentDecisionActionsProps {
  paymentId: string;
  paymentNumber: string;
  amountPesos: number;
  status: PaymentStatus;
  reference?: string;
  hasReceipt: boolean;
}

function readErrorMessage(response: Response): Promise<string> {
  return response
    .json()
    .then((body: { error?: { message?: string } }) =>
      body.error?.message ?? `No se pudo completar la operación (HTTP ${response.status})`,
    )
    .catch(() => `No se pudo completar la operación (HTTP ${response.status})`);
}

/** Abre el comprobante en una pestaña nueva con la URL firmada de corta duración. */
async function abrirComprobante(paymentId: string): Promise<string> {
  const response = await fetch(`/api/payments/${paymentId}/receipt`, { cache: "no-store" });
  if (!response.ok) return readErrorMessage(response);
  const body = (await response.json()) as { receipt?: { url?: string } };
  if (!body.receipt?.url) return "El comprobante no tiene una URL disponible";
  window.open(body.receipt.url, "_blank", "noopener,noreferrer");
  return "";
}

export function PaymentDecisionActions({
  paymentId,
  paymentNumber,
  amountPesos,
  status,
  reference,
  hasReceipt,
}: PaymentDecisionActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<Decision | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  const openDialog = useCallback((decision: Decision) => {
    setPending(decision);
    setError(null);
    setReason("");
    setIdempotencyKey(crypto.randomUUID());
  }, []);

  const closeDialog = useCallback(() => {
    if (isSubmitting) return;
    setPending(null);
    setError(null);
  }, [isSubmitting]);

  const run = useCallback(
    async (decision: Decision, motivo: string) => {
      if (!idempotencyKey) return;
      setIsSubmitting(true);
      setError(null);
      try {
        const response = await fetch(`/api/admin/payments/${paymentId}/${decision}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(decision === "confirm" ? {} : { reason: motivo }),
        });

        if (!response.ok) {
          setError(await readErrorMessage(response));
          return;
        }

        setPending(null);
        const mensajes = {
          confirm: ["Pago confirmado", `${paymentNumber} quedó confirmado.`],
          reject: ["Pago rechazado", `${paymentNumber} fue rechazado y la cuota vuelve a estar pendiente.`],
          reverse: ["Pago revertido", `${paymentNumber} fue revertido y la cuota vuelve a estar pendiente.`],
        } as const;
        toast("success", mensajes[decision][0], mensajes[decision][1]);
        router.refresh();
      } catch (cause) {
        setError(
          `No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo: ${
            cause instanceof Error ? cause.message : "error desconocido"
          }`,
        );
      } finally {
        setIsSubmitting(false);
      }
    },
    [paymentId, paymentNumber, idempotencyKey, router, toast],
  );

  const viewReceipt = useCallback(async () => {
    setError(null);
    try {
      const message = await abrirComprobante(paymentId);
      if (message) setError(message);
    } catch (cause) {
      setError(
        `No se pudo pedir la URL del comprobante: ${
          cause instanceof Error ? cause.message : "error desconocido"
        }`,
      );
    }
  }, [paymentId]);

  const trimmedReason = reason.trim();
  const reasonTooLong = reason.length > MAX_REASON_LENGTH;
  /** Rechazar y revertir exigen motivo; el servidor también lo exige, esto solo evita el viaje. */
  const reasonMissing = pending !== null && pending !== "confirm" && trimmedReason.length === 0;

  const dialogs: Record<Decision, { title: string; description: string; confirmLabel: string }> = {
    confirm: {
      title: "¿Confirmar el pago?",
      description: `Marca ${paymentNumber} por ${formatPesosOrDash(
        amountPesos,
      )} como CONFIRMED y da por pagada su cuota. Solo confirma si el dinero ya está en la cuenta.`,
      confirmLabel: "Sí, confirmar",
    },
    reject: {
      title: "¿Rechazar el pago?",
      description: `Deja ${paymentNumber} en REJECTED y su cuota vuelve a PENDING. El motivo queda registrado y el cliente puede pagar de nuevo.`,
      confirmLabel: "Sí, rechazar",
    },
    reverse: {
      title: "¿Revertir el pago?",
      description: `Deshace la confirmación de ${paymentNumber} y devuelve su cuota a PENDING. Úsalo cuando el pago se confirmó por error, no para Replacement.`,
      confirmLabel: "Sí, revertir",
    },
  };

  return (
    <div className="flex flex-col gap-2">
      {error && pending === null ? (
        <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {status === "PENDING" ? (
          <>
            <Button variant="success" onClick={() => openDialog("confirm")}>
              Confirmar
            </Button>
            <Button variant="danger" onClick={() => openDialog("reject")}>
              Rechazar
            </Button>
          </>
        ) : null}
        {status === "CONFIRMED" ? (
          <Button variant="secondary" onClick={() => openDialog("reverse")}>
            Revertir
          </Button>
        ) : null}
        {hasReceipt ? (
          <Button variant="ghost" onClick={viewReceipt}>
            Ver comprobante
          </Button>
        ) : null}
      </div>

      {pending !== null ? (
        <Modal
          open
          onClose={closeDialog}
          title={dialogs[pending].title}
          description={dialogs[pending].description}
          footer={
            <>
              <Button variant="ghost" onClick={closeDialog} disabled={isSubmitting}>
                Cancelar
              </Button>
              <Button
                variant={pending === "confirm" ? "success" : "danger"}
                loading={isSubmitting}
                disabled={reasonMissing || reasonTooLong}
                onClick={() => run(pending, trimmedReason)}
              >
                {dialogs[pending].confirmLabel}
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-muted">
            Monto <strong className="text-ink">{formatPesosOrDash(amountPesos)}</strong>
            {reference ? (
              <>
                {" · "}
                Referencia <strong className="text-ink">{reference}</strong>
              </>
            ) : (
              " · sin referencia"
            )}
          </p>
          {pending !== "confirm" ? (
            <div className="mt-3">
              <Textarea
                label="Motivo"
                maxLength={MAX_REASON_LENGTH}
                required
                placeholder="Ej. el dinero nunca llegó a la cuenta"
                hint={`${reason.length}/${MAX_REASON_LENGTH} caracteres. Queda en el pago y en la auditoría.`}
                error={reasonTooLong ? `Máximo ${MAX_REASON_LENGTH} caracteres.` : undefined}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={isSubmitting}
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
