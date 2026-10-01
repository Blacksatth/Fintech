"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatPesos } from "@/server/money";
import {
  delinquencyStatusLabel,
  delinquencyStatusTone,
  formatDateTime,
  formatDueDate,
  installmentStatusLabel,
  installmentStatusTone,
  loanStatusLabel,
  loanStatusTone,
  toDate,
} from "@/lib/credit-labels";
import { PayInstallment } from "@/components/credit/pay-installment";
import { PaymentHistory, type ListedPayment } from "@/components/credit/payment-history";
import type { DelinquencyStatus, InstallmentStatus, LoanStatus } from "@/server/types";

interface InstallmentRow {
  id: string;
  installmentNumber: number;
  dueDate: string;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  totalPesos: number;
  paidPesos: number;
  status: InstallmentStatus;
  paidAt?: string;
}

export interface LoanDetailPayload {
  loan: {
    id: string;
    loanNumber: string;
    productCode: string;
    status: LoanStatus;
    delinquencyStatus: DelinquencyStatus;
    daysPastDue: number;
    principalPesos: number;
    interestPesos: number;
    feePesos: number;
    totalPayablePesos: number;
    outstandingPesos: number;
    createdAt: string;
  };
  installments: InstallmentRow[];
  nextDueAt: string | null;
  nextInstallmentId: string | null;
  installmentCount: number;
  paidInstallments: number;
  outstandingPesos: number;
}

export interface LoanDetailProps {
  /** El detalle lo lee el servidor (`page.tsx`): aquí no hay peticiones ni estados de carga. */
  data: LoanDetailPayload;
  payments: ListedPayment[];
  /** Fallo al leer el historial: el calendario se muestra igual, el historial avisa. */
  paymentsError: string | null;
}

/**
 * Detalle del préstamo: resumen, calendario de cuotas con la acción de pago e historial.
 *
 * Solo es un presentador. Los datos llegan del Server Component y, cuando se registra un pago,
 * `router.refresh()` vuelve a pedirlos: por eso aquí no hay ningún `useEffect` que los recargue
 * (eso no se re-ejecuta al refrescar) ni estados duplicados que puedan quedar desfasados.
 */
export function LoanDetail({ data, payments, paymentsError }: LoanDetailProps) {
  const { loan, installments, nextDueAt, nextInstallmentId } = data;
  const proximo = toDate(nextDueAt);
  const saldoCerrado = installments.every((c) => c.status === "PAID");
  // El servidor rechaza con 409 un segundo pago de la misma cuota (`pendingPaymentId`); aquí se
  // evita siquiera ofrecerlo, y se explica por qué, en vez de dejar un error 409 sin contexto.
  const cuotasConPagoPendiente = new Set(
    payments.filter((p) => p.status === "PENDING").map((p) => p.installmentId),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-bold tracking-tight text-ink">{loan.loanNumber}</h2>
        <Badge tone={loanStatusTone(loan.status)}>{loanStatusLabel(loan.status)}</Badge>
        <Badge tone={delinquencyStatusTone(loan.delinquencyStatus)}>
          {delinquencyStatusLabel(loan.delinquencyStatus)}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resumen del préstamo</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-ink-muted">Capital</dt>
              <dd className="font-medium text-ink">{formatPesos(loan.principalPesos)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Interés</dt>
              <dd className="font-medium text-ink">{formatPesos(loan.interestPesos)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Tarifa</dt>
              <dd className="font-medium text-ink">{formatPesos(loan.feePesos)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Total a pagar</dt>
              <dd className="font-medium text-ink">{formatPesos(loan.totalPayablePesos)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Saldo pendiente</dt>
              <dd className="font-medium text-ink">{formatPesos(data.outstandingPesos)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Próximo vencimiento</dt>
              <dd className="font-medium text-ink">
                {saldoCerrado || !proximo ? (
                  "Sin cuotas pendientes"
                ) : (
                  <time dateTime={proximo.toISOString()}>{formatDueDate(proximo)}</time>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Cuotas pagadas</dt>
              <dd className="font-medium text-ink">
                {data.paidInstallments} de {data.installmentCount}
              </dd>
            </div>
            {loan.daysPastDue > 0 && (
              <div>
                <dt className="text-ink-muted">Días de atraso</dt>
                <dd className="font-medium text-danger">{loan.daysPastDue}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Calendario de cuotas</CardTitle>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          <Table>
            <caption className="sr-only">
              Cuotas del préstamo {loan.loanNumber}: número, vencimiento, capital, interés, tarifa,
              total y estado.
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">#</TableHead>
                <TableHead scope="col">Vencimiento</TableHead>
                <TableHead scope="col" className="text-right">Capital</TableHead>
                <TableHead scope="col" className="text-right">Interés</TableHead>
                <TableHead scope="col" className="text-right">Tarifa</TableHead>
                <TableHead scope="col" className="text-right">Total</TableHead>
                <TableHead scope="col">Estado</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Pagar</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {installments.length === 0 ? (
                <TableEmpty colSpan={8}>
                  Este préstamo todavía no tiene cuotas generadas.
                </TableEmpty>
              ) : (
                installments.map((cuota) => {
                  const esProxima = cuota.id === nextInstallmentId;
                  // Mientras el préstamo no se ha desembolsado el calendario es provisional
                  // (decisión de F9): no cabe hablar de "vencida" sobre fechas que aún no
                  // corren. Ver IMPLEMENTATION_PLAN F9-1.
                  const vigente = loan.status !== "PENDING_DISBURSEMENT";
                  const vencida =
                    vigente && cuota.status === "PENDING" && cuota.dueDate < new Date().toISOString();
                  return (
                    <TableRow key={cuota.id} className={esProxima ? "bg-primary-50" : undefined}>
                      <TableCell className="font-medium text-ink">
                        {cuota.installmentNumber}
                        {esProxima && <span className="sr-only"> (próxima a vencer)</span>}
                      </TableCell>
                      <TableCell>
                        <time dateTime={cuota.dueDate}>{formatDueDate(cuota.dueDate)}</time>
                        {vencida && <span className="block text-xs text-danger">Vencida</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatPesos(cuota.principalPesos)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPesos(cuota.interestPesos)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPesos(cuota.feePesos)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums text-ink">
                        {formatPesos(cuota.totalPesos)}
                      </TableCell>
                      <TableCell>
                        <Badge tone={installmentStatusTone(cuota.status)}>
                          {installmentStatusLabel(cuota.status)}
                        </Badge>
                        {cuota.paidAt && (
                          <span className="block text-xs text-ink-muted">
                            Pagada el {formatDateTime(cuota.paidAt)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {/* Solo se paga un préstamo desembolsado y una cuota pendiente: antes del
                            desembolso el calendario es provisional (F9-1). */}
                        {loan.status === "DISBURSED" && cuota.status === "PENDING" ? (
                          cuotasConPagoPendiente.has(cuota.id) ? (
                            <span className="text-xs text-ink-muted">Pago en revisión</span>
                          ) : (
                            <PayInstallment
                              loanId={loan.id}
                              installmentId={cuota.id}
                              installmentNumber={cuota.installmentNumber}
                              totalPesos={cuota.totalPesos}
                            />
                          )
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <PaymentHistory payments={payments} error={paymentsError} />

      <Link href="/mis-prestamos">
        <Button variant="secondary">Volver a mis préstamos</Button>
      </Link>
    </div>
  );
}
