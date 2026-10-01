"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Modal, Textarea, useToast } from "@/components/ui";
import { formatPesos } from "@/server/money";

const MAX_NOTES_LENGTH = 2000;

type PendingAction = "approve" | "reject" | null;

export interface ApplicationDecisionActionsProps {
  applicationId: string;
  requestedAmountPesos: number;
  applicationNumber: string;
  /** Sin score, aprobar falla con 409: el botón se deshabilita y se explica por qué. */
  hasScore: boolean;
}

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // respuesta sin JSON utilizable
  }
  return `No se pudo completar la decisión (HTTP ${response.status})`;
}

export function ApplicationDecisionActions({
  applicationId,
  requestedAmountPesos,
  applicationNumber,
  hasScore,
}: ApplicationDecisionActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingAction>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // La clave se genera al abrir el diálogo y se reutiliza en los reintentos: un
  // doble clic o un reintento por red no debe decidir dos veces.
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  const openDialog = useCallback((action: Exclude<PendingAction, null>) => {
    setPending(action);
    setError(null);
    setIdempotencyKey(newIdempotencyKey());
    setReason("");
  }, []);

  const closeDialog = useCallback(() => {
    if (isSubmitting) return;
    setPending(null);
    setError(null);
  }, [isSubmitting]);

  const decide = useCallback(
    async (action: Exclude<PendingAction, null>, notes: string) => {
      if (!idempotencyKey) return;
      setIsSubmitting(true);
      setError(null);
      try {
        const response = await fetch(`/api/admin/loan-applications/${applicationId}/${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ decisionNotes: notes }),
        });

        if (!response.ok) {
          setError(await readErrorMessage(response));
          return;
        }

        setPending(null);
        toast(
          "success",
          action === "approve" ? "Solicitud aprobada" : "Solicitud rechazada",
          `${applicationNumber} quedó ${action === "approve" ? "aprobada" : "rechazada"}.`,
        );
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
    [applicationId, applicationNumber, idempotencyKey, router, toast],
  );

  const trimmedReason = reason.trim();
  const reasonMissing = trimmedReason.length === 0;
  const reasonTooLong = reason.length > MAX_NOTES_LENGTH;

  return (
    <div className="flex flex-col gap-3">
      {error && !pending ? (
        <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button
          variant="success"
          onClick={() => openDialog("approve")}
          disabled={!hasScore}
          title={hasScore ? undefined : "No se puede aprobar sin score calculado"}
        >
          Aprobar
        </Button>
        <Button variant="danger" onClick={() => openDialog("reject")}>
          Rechazar
        </Button>
      </div>

      {!hasScore ? (
        <p className="rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning">
          <strong className="font-semibold">No se puede aprobar.</strong> Esta solicitud no tiene
          score crediticio calculado, y el sistema la rechazará con un error de conflicto. Puedes
          rechazarla con un motivo.
        </p>
      ) : null}

      <Modal
        open={pending === "approve"}
        onClose={closeDialog}
        title="¿Aprobar esta solicitud?"
        description={`Se aprobará ${applicationNumber} por ${formatPesos(
          requestedAmountPesos,
        )}. La decisión es irreversible desde esta pantalla y notifica a la solicitante.`}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={isSubmitting}>
              Cancelar
            </Button>
            <Button
              variant="success"
              loading={isSubmitting}
              onClick={() => decide("approve", "")}
            >
              Sí, aprobar
            </Button>
          </>
        }
      >
        <Textarea
          label="Notas de la decisión (opcional)"
          hideLabel={false}
          maxLength={MAX_NOTES_LENGTH}
          rows={3}
          placeholder="Ej.Verificación de documentos conforme."
          hint="Queda registrado en la auditoría."
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={isSubmitting}
        />
        {error ? (
          <p role="alert" className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </Modal>

      <Modal
        open={pending === "reject"}
        onClose={closeDialog}
        title="Rechazar esta solicitud"
        description={`El motivo es obligatorio: la solicitante lo verá en su historial. ${applicationNumber}.`}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={isSubmitting}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              loading={isSubmitting}
              disabled={reasonMissing || reasonTooLong}
              onClick={() => decide("reject", trimmedReason)}
            >
              Rechazar
            </Button>
          </>
        }
      >
        <Textarea
          label="Motivo del rechazo"
          maxLength={MAX_NOTES_LENGTH}
          rows={4}
          required
          placeholder="Ej. No cumple con los requisitos de ingresos del producto."
          hint={
            reasonTooLong
              ? undefined
              : `${reason.length}/${MAX_NOTES_LENGTH} caracteres. Se muestra al cliente.`
          }
          error={reasonTooLong ? `Máximo ${MAX_NOTES_LENGTH} caracteres.` : undefined}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={isSubmitting}
        />
        {error ? (
          <p role="alert" className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
