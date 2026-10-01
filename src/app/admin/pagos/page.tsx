import Link from "next/link";
import { getDb } from "@/lib/admin";
import { formatPesosOrDash } from "@/server/money";
import { formatDateTime, paymentChannelLabel, paymentStatusLabel, paymentStatusTone, shortUid } from "@/lib/credit-labels";
import {
  Badge,
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
import { PaymentDecisionActions } from "@/components/admin/payment-decision-actions";
import { ADMIN_PAYMENT_FILTERS, listPaymentsForAdmin } from "@/services/payments/payment-list-service";
import { PaymentStatus } from "@/server/types";

/** Sin `?estado=` la cola sale en `PENDING`, que es lo que hay que resolver. */
const DEFAULT_FILTER = PaymentStatus.PENDING;

const FILTER_VALUES = new Set<string>(ADMIN_PAYMENT_FILTERS);

/** Solo acepta un estado conocido: la URL es entrada de usuario. */
function parseStatusFilter(value: string | string[] | undefined): PaymentStatus {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !FILTER_VALUES.has(raw)) return DEFAULT_FILTER;
  return raw as PaymentStatus;
}

export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { estado } = await searchParams;
  const statusFilter = parseStatusFilter(estado);
  const payments = await listPaymentsForAdmin({ db: getDb() }, { status: statusFilter });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Pagos</h1>
          <p className="text-sm text-ink-muted">
            {statusFilter === PaymentStatus.PENDING
              ? "Pagos registrados a la espera de revisión, más recientes primero"
              : `Pagos ${paymentStatusLabel(statusFilter).toLowerCase()}, más recientes primero`}
          </p>
        </div>
        <p className="text-sm text-ink-muted" aria-live="polite">
          {payments.length} resultado{payments.length === 1 ? "" : "s"}
        </p>
      </div>

      <nav aria-label="Filtrar pagos por estado" className="flex flex-wrap gap-2">
        {ADMIN_PAYMENT_FILTERS.map((status) => {
          const isActive = statusFilter === status;
          return (
            <Link
              key={status}
              href={`/admin/pagos?estado=${status}`}
              aria-current={isActive ? "page" : undefined}
              className={
                isActive
                  ? "rounded-full border border-primary-600 bg-primary-50 px-3 py-1.5 text-sm font-semibold text-primary-700"
                  : "rounded-full border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink-muted transition-colors hover:border-primary-600 hover:text-ink"
              }
            >
              {paymentStatusLabel(status)}
            </Link>
          );
        })}
      </nav>

      <Card>
        <CardHeader>
          <CardTitle>Resultado</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Número</TableHead>
                <TableHead scope="col">Cliente</TableHead>
                <TableHead scope="col">Préstamo</TableHead>
                <TableHead scope="col">Monto</TableHead>
                <TableHead scope="col">Canal</TableHead>
                <TableHead scope="col">Referencia</TableHead>
                <TableHead scope="col">Alta</TableHead>
                <TableHead scope="col">Estado</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Acciones</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.length === 0 ? (
                <TableEmpty colSpan={9}>
                  {statusFilter === PaymentStatus.PENDING
                    ? "No hay pagos esperando revisión."
                    : `No hay pagos ${paymentStatusLabel(statusFilter).toLowerCase()}.`}
                </TableEmpty>
              ) : (
                payments.map((payment) => (
                  <TableRow key={payment.paymentId}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {payment.paymentNumber}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-ink-muted whitespace-nowrap">
                      {shortUid(payment.userId)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Link
                        href={`/admin/prestamos/${payment.loanId}`}
                        className="text-sm font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-800"
                      >
                        Ver préstamo
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatPesosOrDash(payment.amountPesos)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-ink-muted">
                      {paymentChannelLabel(payment.channel)}
                    </TableCell>
                    <TableCell className="text-xs text-ink-muted">
                      {payment.reference ?? <span className="text-ink-muted/70">Sin referencia</span>}
                      {payment.hasReceipt ? (
                        <span className="block text-xs text-primary-700">Con comprobante</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-ink-muted">
                      {formatDateTime(payment.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={paymentStatusTone(payment.status)}>
                        {paymentStatusLabel(payment.status)}
                      </Badge>
                      {payment.reason ? (
                        <span className="block max-w-40 truncate text-xs text-ink-muted" title={payment.reason}>
                          {payment.reason}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <PaymentDecisionActions
                        paymentId={payment.paymentId}
                        paymentNumber={payment.paymentNumber}
                        amountPesos={payment.amountPesos}
                        status={payment.status}
                        reference={payment.reference}
                        hasReceipt={payment.hasReceipt}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
