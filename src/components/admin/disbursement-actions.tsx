"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Modal, useToast } from "@/components/ui";
import { formatPesosOrDash } from "@/server/money";

/**
 * Acciones de desembolso (F9-2). El flujo es deliberadamente de dos pasos y no se puede
 * saltar: `initiate` registra la referencia y `confirm` es el que mueve el préstamo a
 * `DISBURSED` y re-programa el calendario.
 *
 * Cada paso genera su clave de idempotencia al abrir el diálogo y la **reutiliza** en los
 * reintentos: un doble clic o un reintento por red no puede transferir dos veces.
 */

const MAX_REFERENCE_LENGTH = 120;

type PendingAction = "initiate" | "confirm" | null;

export interface DisbursementActionsProps {
  loanId: string;
  loanNumber: string;
  /** Capital a transferir: el admin lo ve antes de hacer nada. `undefined` en documentos legacy. */
  principalPesos: number | undefined;
  /** Estado del desembolso; `null` = todavía no iniciado. */
  disbursementStatus: "PENDING" | "INITIATED" | "CONFIRMED" | "CANCELLED" | null;
  /** Referencia ya registrada al iniciar, si la hay. */
  reference: string | null;
  /** `true` si el préstamo no puede confirmarse por falta de snapshot de pricing. */
  blockedByMissingPricing: boolean;
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
  return `No se pudo completar la operación (HTTP ${response.status})`;
}

export function DisbursementActions({
  loanId,
  loanNumber,
  principalPesos,
  disbursementStatus,
  reference,
  blockedByMissingPricing,
}: DisbursementActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingAction>(null);
  const [newReference, setNewReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  const openDialog = useCallback((action: Exclude<PendingAction, null>) => {
    setPending(action);
    setError(null);
    setIdempotencyKey(newIdempotencyKey());
    // Al confirmar sin referencia previa se propone la ya registrada: el admin solo confirma.
    setNewReference(reference ?? "");
  }, [reference]);

  const closeDialog = useCallback(() => {
    if (isSubmitting) return;
    setPending(null);
    setError(null);
  }, [isSubmitting]);

  const run = useCallback(
    async (action: Exclude<PendingAction, null>, ref: string) => {
      if (!idempotencyKey) return;
      setIsSubmitting(true);
      setError(null);
      try {
        const response = await fetch(`/api/admin/loans/${loanId}/disburse/${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(ref.length > 0 ? { reference: ref } : {}),
        });

        if (!response.ok) {
          setError(await readErrorMessage(response));
          return;
        }

        setPending(null);
        const body = (await response.json()) as {
          disbursement?: { rescheduledInstallments?: number };
        };
        const rescheduled = body.disbursement?.rescheduledInstallments ?? 0;
        toast(
          "success",
          action === "initiate" ? "Desembolso iniciado" : "Desembolso confirmado",
          action === "initiate"
            ? `${loanNumber} queda pendiente de confirmar.`
            : `${loanNumber} quedó desembolsado${
                rescheduled > 0 ? ` y se re-programaron ${rescheduled} vencimientos` : ""
              }.`,
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
    [loanId, loanNumber, idempotencyKey, router, toast],
  );

  const trimmedReference = newReference.trim();
  const referenceMissing = trimmedReference.length === 0;
  const referenceTooLong = newReference.length > MAX_REFERENCE_LENGTH;

  return (
    <div className="flex flex-col gap-3">
      {error && !pending ? (
        <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {disbursementStatus === "INITIATED" ? (
        <Button variant="success" onClick={() => openDialog("confirm")}>
          Confirmar desembolso
        </Button>
      ) : (
        <Button
          variant="primary"
          onClick={() => openDialog("initiate")}
          disabled={blockedByMissingPricing}
          title={
            blockedByMissingPricing
              ? "Este préstamo no tiene snapshot de pricing: el servidor no puede re-programar su calendario"
              : undefined
          }
        >
          Iniciar desembolso
        </Button>
      )}

      {blockedByMissingPricing ? (
        <p className="rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning">
          <strong className="font-semibold">No se puede confirmar.</strong> Este préstamo se creó
          antes de que existiera el snapshot de pricing, así que el servidor no puede re-programar
          su calendario sin cambiar lo que el cliente aceptó. Requiere una migración de datos.
        </p>
      ) : null}

      <Modal
        open={pending === "initiate"}
        onClose={closeDialog}
        title="Iniciar desembolso"
        description={`Registra la referencia de la transferencia de ${formatPesosOrDash(
          principalPesos,
        )} a ${loanNumber}. Esto no mueve el préstamo: solo deja constancia de la referencia para la confirmación.`}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={isSubmitting}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              loading={isSubmitting}
              disabled={referenceMissing || referenceTooLong}
              onClick={() => run("initiate", trimmedReference)}
            >
              Iniciar
            </Button>
          </>
        }
      >
        <Input
          label="Referencia de la transferencia"
          maxLength={MAX_REFERENCE_LENGTH}
          required
          placeholder="Ej. REF-NEQUI-884512"
          hint={
            referenceTooLong
              ? undefined
              : `${newReference.length}/${MAX_REFERENCE_LENGTH} caracteres. Queda en la auditoría.`
          }
          error={referenceTooLong ? `Máximo ${MAX_REFERENCE_LENGTH} caracteres.` : undefined}
          value={newReference}
          onChange={(event) => setNewReference(event.target.value)}
          disabled={isSubmitting}
        />
        {error ? (
          <p role="alert" className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </Modal>

      <Modal
        open={pending === "confirm"}
        onClose={closeDialog}
        title="¿Confirmar el desembolso?"
        description={`Esta acción marca ${loanNumber} como DESEMBURSADO y fija los vencimientos de sus cuotas desde hoy. Solo confirma si la transferencia de ${formatPesosOrDash(
          principalPesos,
        )} ya salió de verdad.`}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={isSubmitting}>
              Cancelar
            </Button>
            <Button
              variant="success"
              loading={isSubmitting}
              disabled={referenceMissing || referenceTooLong}
              onClick={() => run("confirm", trimmedReference)}
            >
              Sí, confirmar
            </Button>
          </>
        }
      >
        <Input
          label="Referencia de la transferencia"
          maxLength={MAX_REFERENCE_LENGTH}
          required
          placeholder="Ej. REF-NEQUI-884512"
          hint="Es la que quedó registrada al iniciar. Cámbiala solo si la transferencia se hizo con otra referencia."
          value={newReference}
          onChange={(event) => setNewReference(event.target.value)}
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
