"use client";

import { useCallback, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { formatPesos } from "@/server/money";
import { formatDateTime, paymentChannelLabel, paymentStatusLabel, paymentStatusTone } from "@/lib/credit-labels";
import type { InstallmentStatus, PaymentStatus } from "@/server/types";

/**
 * Historial de pagos del préstamo (F10-4).
 *
 * Recibe los pagos por props en vez de cargarlos: quien lo monta (`LoanDetail`) necesita la misma
 * lista para no ofrecer "Pagar" en una cuota que ya tiene un pago pendiente, y dos fetches del
 * mismo endpoint acabarían mostrando dos verdades distintas.
 *
 * El comprobante **nunca** se enlaza con una URL guardada. `payments.receiptUrl` es una referencia
 * de entrega, no un enlace: para verlo hay que pedir `/receipt`, que devuelve una URL firmada de
 * minutos. Un `href` directo a `receiptUrl` sería un 403 y, si algún día funcionara, sería una URL
 * pública.
 */

export interface ListedPayment {
  paymentId: string;
  paymentNumber: string;
  amountPesos: number;
  channel: string;
  reference?: string;
  status: PaymentStatus;
  hasReceipt: boolean;
  createdAt: string;
  installmentId: string;
  installmentNumber: number;
  installmentStatus: InstallmentStatus;
}

function readErrorMessage(response: Response): Promise<string> {
  return response
    .json()
    .then((body: { error?: { message?: string } }) =>
      body.error?.message ?? `No se pudo completar la operación (HTTP ${response.status})`,
    )
    .catch(() => `No se pudo completar la operación (HTTP ${response.status})`);
}

export function PaymentHistory({
  payments,
  error,
}: {
  payments: ListedPayment[] | null;
  /** Error de carga del historial, si lo hubo. */
  error?: string | null;
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  /** Pide la URL firmada de un comprobante y la abre en otra pestaña. */
  const viewReceipt = useCallback(async (paymentId: string) => {
    setViewing(paymentId);
    setActionError(null);
    try {
      const response = await fetch(`/api/payments/${paymentId}/receipt`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readErrorMessage(response));
      const body = (await response.json()) as { receipt?: { url?: string } };
      if (!body.receipt?.url) throw new Error("El comprobante no tiene una URL disponible");
      window.open(body.receipt.url, "_blank", "noopener,noreferrer");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "No se pudo abrir el comprobante");
    } finally {
      setViewing(null);
    }
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Historial de pagos</CardTitle>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        {error || actionError ? (
          <p role="alert" className="mx-4 mb-3 rounded-md bg-danger-bg p-3 text-sm text-danger sm:mx-0">
            {actionError ?? error}
          </p>
        ) : null}
        <Table>
          <caption className="sr-only">
            Pagos registrados de este préstamo: fecha, cuota, monto, canal, referencia, estado y
            comprobante.
          </caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Fecha</TableHead>
              <TableHead scope="col">Cuota</TableHead>
              <TableHead scope="col" className="text-right">Monto</TableHead>
              <TableHead scope="col">Canal</TableHead>
              <TableHead scope="col">Referencia</TableHead>
              <TableHead scope="col">Estado</TableHead>
              <TableHead scope="col">Comprobante</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments === null && error === null ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-ink-muted">
                  <span role="status">Cargando el historial de pagos…</span>
                </TableCell>
              </TableRow>
            ) : payments?.length === 0 ? (
              <TableEmpty colSpan={7}>Todavía no registras pagos en este préstamo.</TableEmpty>
            ) : (
              payments?.map((payment) => (
                <TableRow key={payment.paymentId}>
                  <TableCell className="whitespace-nowrap text-ink-muted">
                    {formatDateTime(payment.createdAt)}
                  </TableCell>
                  <TableCell className="font-medium text-ink">#{payment.installmentNumber}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums text-ink">
                    {formatPesos(payment.amountPesos)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-ink-muted">
                    {paymentChannelLabel(payment.channel)}
                  </TableCell>
                  <TableCell className="text-xs text-ink-muted">
                    {payment.reference ?? <span className="text-ink-muted/70">Sin referencia</span>}
                  </TableCell>
                  <TableCell>
                    <Badge tone={paymentStatusTone(payment.status)}>
                      {paymentStatusLabel(payment.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {payment.hasReceipt ? (
                      <Button
                        variant="ghost"
                        onClick={() => viewReceipt(payment.paymentId)}
                        loading={viewing === payment.paymentId}
                      >
                        Ver
                      </Button>
                    ) : (
                      <span className="text-xs text-ink-muted/70">No adjuntado</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
