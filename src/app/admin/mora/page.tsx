import Link from "next/link";
import { getDb } from "@/lib/admin";
import { DelinquencyStatus } from "@/server/types";
import {
  DELINQUENCY_FILTERS,
  DELINQUENCY_SCAN_LIMIT,
  listDelinquencyForAdmin,
} from "@/services/credit/delinquency-service";
import { formatPesosOrDash } from "@/server/money";
import {
  delinquencyStatusLabel,
  delinquencyStatusTone,
  formatDateTime,
  formatDueDate,
  shortUid,
} from "@/lib/credit-labels";
import { DelinquencyRecalcActions, LoanRecalcButton } from "@/components/admin/delinquency-recalc-actions";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Stat,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";

const FILTER_VALUES = new Set<string>(DELINQUENCY_FILTERS);

/** La URL es entrada de usuario: un estado desconocido se ignora en vez de romper la pantalla. */
function parseStatusFilter(value: string | string[] | undefined): DelinquencyStatus | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !FILTER_VALUES.has(raw)) return undefined;
  return raw as DelinquencyStatus;
}

/**
 * Cartera de mora (F11).
 *
 * `listDelinquencyForAdmin` recalcula en memoria y **no escribe** al abrir la página: lo que se ve
 * es la mora de hoy, no la del último pago. Lo que escribe es el botón "Recalcular cartera", que
 * además dispara los avisos de cuota y deja auditoría — por eso la columna de caché y el botón por
 * fila existen: para que el admin vea si lo guardado está viejo y pueda corregirlo.
 */
export default async function AdminDelinquencyPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { estado } = await searchParams;
  const statusFilter = parseStatusFilter(estado);
  const { rows, summary, thresholds, truncated } = await listDelinquencyForAdmin(
    { db: getDb() },
    { filter: { status: statusFilter } },
  );

  const sinCalcular = rows.filter((row) => row.recalc === null).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Cartera de mora</h1>
          <p className="text-sm text-ink-muted">
            {statusFilter
              ? `Filtrando por ${delinquencyStatusLabel(statusFilter).toLowerCase()}, recalculado a hoy`
              : "Todos los préstamos activos, recalculados a hoy"}
          </p>
        </div>
        <p className="text-sm text-ink-muted" aria-live="polite">
          {rows.length} fila{rows.length === 1 ? "" : "s"}
          {sinCalcular > 0 ? ` · ${sinCalcular} sin calcular` : ""}
        </p>
      </div>

      <Card>
        <CardHeader className="flex-wrap items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <CardTitle>Totales de la cartera activa</CardTitle>
            <p className="text-sm text-ink-muted">
              Mora hasta {thresholds.overdueDays} día
              {thresholds.overdueDays === 1 ? "" : "s"} = vencida; a partir de {thresholds.defaultDays} =
              en mora. Próxima a partir de {thresholds.dueSoonDays} día
              {thresholds.dueSoonDays === 1 ? "" : "s"}.
            </p>
          </div>
          <DelinquencyRecalcActions />
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Cartera por cobrar" valuePesos={summary.outstandingPesos} />
            <Stat label="Vencida" valuePesos={summary.overduePesos} tone="warning" />
            <Stat label="En mora" valuePesos={summary.inDefaultPesos} tone="danger" />
            <Stat
              label="Próximas a vencer"
              valuePesos={summary.dueSoonPesos}
              meta="Dentro de la ventana de aviso"
            />
          </div>
          {/* Conteo y mayor atraso van en texto, no en `Stat`: `Stat` formatea pesos y un número de
              préstamos o de días ahí se leería como saldo. */}
          <p className="mt-4 text-sm text-ink-muted">
            {summary.loans} préstamo{summary.loans === 1 ? "" : "s"} calculado
            {summary.loans === 1 ? "" : "s"} ·{" "}
            {summary.maxDaysPastDue === 0
              ? "ninguno vencido"
              : `mayor atraso ${summary.maxDaysPastDue} día${
                  summary.maxDaysPastDue === 1 ? "" : "s"
                }`}{" "}
            · {summary.byStatus.DEFAULT} en mora profunda
          </p>
        </CardContent>
      </Card>

      {truncated ? (
        <p role="status" className="rounded-lg border border-warn-300 bg-warn-50 p-3 text-sm text-warn-800">
          Se revisaron {DELINQUENCY_SCAN_LIMIT} préstamos como máximo por pasada, así que estos totales
          son un piso y no el total de la cartera. Con más cartera habrá que paginar el escaneo.
        </p>
      ) : null}

      <nav aria-label="Filtrar por estado de mora" className="flex flex-wrap gap-2">
        <FilterPill href="/admin/mora" active={!statusFilter}>
          Todos
        </FilterPill>
        {DELINQUENCY_FILTERS.map((status) => (
          <FilterPill key={status} href={`/admin/mora?estado=${status}`} active={statusFilter === status}>
            {delinquencyStatusLabel(status)}
          </FilterPill>
        ))}
      </nav>

      <Card>
        <CardHeader>
          <CardTitle>Préstamos</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Número</TableHead>
                <TableHead>Titular</TableHead>
                <TableHead>Saldo</TableHead>
                <TableHead>Próxima cuota</TableHead>
                <TableHead>Atraso de la cuota</TableHead>
                <TableHead>Mora</TableHead>
                <TableHead>Caché guardada</TableHead>
                <TableHead>
                  <span className="sr-only">Acción</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableEmpty colSpan={8}>No hay préstamos en este filtro.</TableEmpty>
              ) : (
                rows.map((row) => {
                  const cuota = row.nextInstallment;
                  const vencida = row.nextInstallmentDaysPastDue > 0;
                  return (
                    <TableRow key={row.loanId}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        <Link
                          href={`/admin/prestamos/${row.loanId}`}
                          className="font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-800"
                        >
                          {row.loanNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm text-ink-muted">
                        {row.holder
                          ? `${row.holder.fullName} (${shortUid(row.userId)})`
                          : shortUid(row.userId)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatPesosOrDash(row.recalc?.outstandingPesos)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-ink-muted">
                        {cuota ? (
                          <>
                            #{cuota.installmentNumber} · {formatDueDate(cuota.dueDate)}
                          </>
                        ) : row.error ? (
                          "—"
                        ) : (
                          "Sin cuotas impagas"
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {row.error ? (
                          <span className="text-sm text-ink-muted">—</span>
                        ) : vencida ? (
                          <span className="font-semibold text-danger">
                            {row.nextInstallmentDaysPastDue} día
                            {row.nextInstallmentDaysPastDue === 1 ? "" : "s"}
                          </span>
                        ) : (
                          <span className="text-ink-muted">
                            {cuota ? "Al día" : "—"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.recalc ? (
                          <div className="flex flex-col items-start gap-1">
                            <Badge tone={delinquencyStatusTone(row.recalc.delinquencyStatus)}>
                              {delinquencyStatusLabel(row.recalc.delinquencyStatus)}
                            </Badge>
                            <span className="text-xs whitespace-nowrap text-ink-muted">
                              {row.recalc.daysPastDue} día{row.recalc.daysPastDue === 1 ? "" : "s"} de
                              atraso
                            </span>
                          </div>
                        ) : (
                          <Badge tone="warning">Sin calcular</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-ink-muted">
                        {row.error ? (
                          <span className="line-clamp-2 max-w-xs" title={row.error}>
                            {row.error}
                          </span>
                        ) : (
                          <>
                            <Badge tone={delinquencyStatusTone(row.cache.delinquencyStatus)}>
                              {delinquencyStatusLabel(row.cache.delinquencyStatus)}
                            </Badge>
                            <span className="ml-2">{formatDateTime(row.cache.updatedAt ?? null)}</span>
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        <LoanRecalcButton loanId={row.loanId} loanNumber={row.loanNumber} />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function FilterPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-full border border-primary-600 bg-primary-50 px-3 py-1.5 text-sm font-semibold text-primary-700"
          : "rounded-full border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink-muted transition-colors hover:border-primary-600 hover:text-ink"
      }
    >
      {children}
    </Link>
  );
}
