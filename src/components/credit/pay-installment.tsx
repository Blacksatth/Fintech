"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Modal, useToast } from "@/components/ui";
import { formatPesos } from "@/server/money";

/**
 * Registro de pago de una cuota (F10-4, §9).
 *
 * El orden importa y es deliberado: **primero se registra el pago, después se sube el comprobante.**
 * Al revés no se podría, porque el comprobante cuelga del pago. Por eso la subida fallida no es un
 * error que se pueda deshacer: el pago ya existe en `PENDING` y el cliente puede reintentar solo la
 * subida, o escribir al admin. La UI lo dice en vez de tragarse el error.
 *
 * Lo que el cliente NO puede hacer aquí es confirmar nada: un pago registrado no está pagado hasta
 * que un admin lo revisa contra el banco (§11).
 *
 * **La referencia es obligatoria en la UI aunque la API la acepte como opcional**: sin referencia el
 * admin no tiene nada contra lo que comparar el movimiento, que es el trabajo manual que sostiene
 * la confirmación. El servidor no la exige porque la regla de negocio vive en la pantalla, donde se
 * puede explicar.
 */

const MAX_REFERENCE_LENGTH = 120;
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = "image/png,image/jpeg,application/pdf";

interface PublicChannel {
  id: string;
  name: string;
  type: string;
  instructionsText: string;
  meta: Partial<
    Record<
      | "bankName"
      | "accountType"
      | "accountNumber"
      | "accountHolder"
      | "nequiNumber"
      | "clauseDialogoActivo"
      | "qrImageUrl",
      string
    >
  >;
}

export interface PayInstallmentProps {
  loanId: string;
  installmentId: string;
  installmentNumber: number;
  totalPesos: number;
}

function readErrorMessage(response: Response): Promise<string> {
  return response
    .json()
    .then((body: { error?: { message?: string } }) =>
      body.error?.message ?? `No se pudo completar la operación (HTTP ${response.status})`,
    )
    .catch(() => `No se pudo completar la operación (HTTP ${response.status})`);
}

/** Cuenta del canal en texto que se pueda leer y copiar, sin inventar etiquetas. */
function channelDetails(channel: PublicChannel): Array<{ label: string; value: string }> {
  const { meta } = channel;
  const details: Array<{ label: string; value: string }> = [];
  if (meta.bankName) details.push({ label: "Banco", value: meta.bankName });
  if (meta.accountType) details.push({ label: "Tipo de cuenta", value: meta.accountType });
  if (meta.accountNumber) details.push({ label: "Número de cuenta", value: meta.accountNumber });
  if (meta.nequiNumber) details.push({ label: "Nequi", value: meta.nequiNumber });
  if (meta.accountHolder) details.push({ label: "Titular", value: meta.accountHolder });
  if (meta.clauseDialogoActivo) {
    details.push({ label: "Cláusula de Diálogo Activo", value: meta.clauseDialogoActivo });
  }
  return details;
}

export function PayInstallment({
  loanId,
  installmentId,
  installmentNumber,
  totalPesos,
}: PayInstallmentProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [channels, setChannels] = useState<PublicChannel[] | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  /** Pago ya creado al que le falló la subida: se reintenta solo el comprobante. */
  const [pendingUpload, setPendingUpload] = useState<{ paymentId: string; number: string } | null>(null);

  useEffect(() => {
    if (!open || channels !== null) return;
    let vigente = true;
    const load = async () => {
      try {
        const response = await fetch("/api/payment-channels", { cache: "no-store" });
        if (!response.ok) throw new Error(await readErrorMessage(response));
        const body = (await response.json()) as { channels: PublicChannel[] };
        if (!vigente) return;
        setChannels(body.channels);
        if (body.channels.length === 0) {
          setChannelsError("No hay canales de pago habilitados. Escribe a soporte para pagar.");
        }
      } catch (cause) {
        if (vigente) {
          setChannelsError(
            cause instanceof Error ? cause.message : "No se pudieron cargar los canales de pago",
          );
        }
      }
    };
    void load();
    return () => {
      vigente = false;
    };
  }, [open, channels]);

  const openDialog = useCallback(() => {
    setOpen(true);
    setError(null);
    setReference("");
    setFile(null);
    // La clave se genera al abrir y se reutiliza en los reintentos: un doble clic o un reintento
    // por red no puede registrar dos pagos de la misma cuota.
    setIdempotencyKey(crypto.randomUUID());
  }, []);

  const closeDialog = useCallback(() => {
    if (isSubmitting) return;
    setOpen(false);
    setError(null);
  }, [isSubmitting]);

  const submit = useCallback(async () => {
    if (!channelId || !idempotencyKey) return;
    setIsSubmitting(true);
    setError(null);

    // Sube el comprobante de un pago ya creado. Devuelve el mensaje de error, o `null` si subió.
    const uploadReceipt = async (paymentId: string): Promise<string | null> => {
      const body = new FormData();
      body.append("file", file as File);
      try {
        const response = await fetch(`/api/payments/${paymentId}/receipt`, { method: "POST", body });
        if (!response.ok) return await readErrorMessage(response);
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "error desconocido";
      }
    };

    try {
      const response = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          loanId,
          installmentId,
          channel: channelId,
          reference: reference.trim(),
        }),
      });

      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }

      const body = (await response.json()) as {
        payment?: { paymentId?: string; paymentNumber?: string };
      };
      const paymentId = body.payment?.paymentId ?? "";
      const paymentNumber = body.payment?.paymentNumber ?? "";
      if (!paymentId) {
        setError("El pago se registró pero la respuesta no trae su identificador. Revisa el historial.");
        return;
      }

      if (!file) {
        setOpen(false);
        toast(
          "success",
          "Pago registrado",
          `${paymentNumber} quedó registrado y esperando revisión del administrador.`,
        );
        router.refresh();
        return;
      }

      const uploadError = await uploadReceipt(paymentId);
      if (uploadError !== null) {
        // El pago ya está creado: se avisa y se ofrece reintentar solo la subida, porque pedirle al
        // cliente que registre el pago otra vez sería duplicarlo.
        setPendingUpload({ paymentId, number: paymentNumber });
        setError(
          `Tu pago ${paymentNumber} se registró, pero el comprobante no se pudo subir: ${uploadError}. ` +
            "Puedes reintentarlo aquí; el pago no se registra dos veces.",
        );
        return;
      }

      setOpen(false);
      setPendingUpload(null);
      toast(
        "success",
        "Pago registrado",
        `${paymentNumber} quedó registrado con comprobante y esperando revisión.`,
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
  }, [channelId, idempotencyKey, loanId, installmentId, reference, file, router, toast]);

  /** Reintento de solo el comprobante: el pago ya existe y no se toca. */
  const retryUpload = useCallback(async () => {
    if (!pendingUpload || !file) return;
    setIsSubmitting(true);
    setError(null);
    const body = new FormData();
    body.append("file", file);
    try {
      const response = await fetch(`/api/payments/${pendingUpload.paymentId}/receipt`, {
        method: "POST",
        body,
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      setOpen(false);
      setPendingUpload(null);
      setFile(null);
      toast("success", "Comprobante subido", `${pendingUpload.number} ya tiene comprobante.`);
      router.refresh();
    } catch (cause) {
      setError(
        `No se pudo subir el comprobante: ${
          cause instanceof Error ? cause.message : "error desconocido"
        }`,
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [pendingUpload, file, router, toast]);

  const trimmedReference = reference.trim();
  const referenceMissing = trimmedReference.length === 0;
  const referenceTooLong = reference.length > MAX_REFERENCE_LENGTH;
  const fileTooBig = file !== null && file.size > MAX_RECEIPT_BYTES;
  const canSubmit =
    channelId !== null && !referenceMissing && !referenceTooLong && !fileTooBig && !isSubmitting;

  return (
    <>
      <Button variant="primary" onClick={openDialog} size="sm">
        Pagar
      </Button>

      <Modal
        open={open}
        onClose={closeDialog}
        size="lg"
        title={`Pagar la cuota ${installmentNumber}`}
        description={`Valor a pagar: ${formatPesos(totalPesos)}. Registra tu pago y un administrador lo confirma revisando su cuenta. Subir el comprobante no confirma nada.`}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={isSubmitting}>
              Cancelar
            </Button>
            <Button variant="primary" loading={isSubmitting} disabled={!canSubmit} onClick={submit}>
              Registrar pago
            </Button>
          </>
        }
      >
        {pendingUpload ? (
          <div className="mb-4 rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning">
            <p className="font-semibold">
              El pago {pendingUpload.number} ya está registrado.
            </p>
            <p className="mt-1">
              Si eliges un comprobante puedes subirlo con el botón de abajo. Si prefieres seguir sin
              él, el administrador igual puede confirmar tu pago.
            </p>
          </div>
        ) : null}

        <fieldset className="space-y-3">
          <legend className="font-medium text-ink">¿Por dónde vas a pagar?</legend>
          {channelsError ? (
            <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger">
              {channelsError}
            </p>
          ) : null}
          {channels === null && channelsError === null ? (
            <p className="text-sm text-ink-muted" role="status">
              Cargando los canales de pago…
            </p>
          ) : null}
          <div className="space-y-2">
            {channels?.map((channel) => {
              const isSelected = channelId === channel.id;
              const details = channelDetails(channel);
              return (
                <label
                  key={channel.id}
                  className={`block cursor-pointer rounded-lg border-2 p-3 transition-colors ${
                    isSelected ? "border-primary-600 bg-primary-50" : "border-border hover:border-primary-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="channel"
                    value={channel.id}
                    checked={isSelected}
                    onChange={() => setChannelId(channel.id)}
                    className="sr-only"
                  />
                  <span className="font-medium text-ink">{channel.name}</span>
                  {details.length > 0 ? (
                    <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                      {details.map((detail) => (
                        <div key={detail.label} className="flex justify-between gap-2 sm:block">
                          <dt className="text-ink-muted">{detail.label}</dt>
                          <dd className="font-mono text-ink">{detail.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {channel.meta.qrImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={channel.meta.qrImageUrl}
                      alt={`Código QR para pagar la cuota ${installmentNumber} por ${channel.name}`}
                      className="mt-2 h-40 w-40 rounded-md border border-border bg-surface"
                    />
                  ) : null}
                  <span className="mt-2 block text-sm text-ink-muted">{channel.instructionsText}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-4 space-y-4">
          <Input
            label="Referencia de tu pago"
            maxLength={MAX_REFERENCE_LENGTH}
            required
            placeholder="Ej. NEQUI-884512"
            hint="Es el número que aparece en tu app o en tu comprobante. Es lo que el administrador va a comparar con su banco."
            error={referenceTooLong ? `Máximo ${MAX_REFERENCE_LENGTH} caracteres.` : undefined}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            disabled={isSubmitting}
          />

          <Input
            type="file"
            label="Comprobante (opcional)"
            accept={ACCEPTED_TYPES}
            hint="PDF, JPG o PNG de hasta 5 MB. Adjuntarlo ayuda a que te aprueben más rápido, pero no es obligatorio."
            error={fileTooBig ? "El comprobante supera el máximo de 5 MB." : undefined}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            disabled={isSubmitting || pendingUpload !== null}
          />

          {pendingUpload && file ? (
            <Button variant="primary" loading={isSubmitting} onClick={retryUpload}>
              Reintentar subida del comprobante
            </Button>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
