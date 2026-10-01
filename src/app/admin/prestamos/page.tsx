import Link from "next/link";
import { getDb } from "@/lib/admin";
import { LoanStatus, type LoanStatus as LoanStatusValue } from "@/server/types";
import { listLoansForAdmin } from "@/services/credit/admin-loan-service";
import { formatPesosOrDash } from "@/server/money";
import {
  formatDateTime,
  loanStatusLabel,
  loanStatusTone,
  termFrequencyLabel,
} from "@/lib/credit-labels";
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

const FILTERABLE_STATUSES: readonly LoanStatusValue[] = [
  LoanStatus.PENDING_DISBURSEMENT,
  LoanStatus.DISBURSED,
  LoanStatus.PAID,
  LoanStatus.DEFAULTED,
  LoanStatus.WRITTEN_OFF,
];

const FILTER_VALUES = new Set<string>(FILTERABLE_STATUSES);

/** Solo acepta un estado conocido: la URL es entrada de usuario. */
function parseStatusFilter(value: string | string[] | undefined): LoanStatusValue | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !FILTER_VALUES.has(raw)) return undefined;
  return raw as LoanStatusValue;
}

export default async function AdminLoansPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { estado } = await searchParams;
  const statusFilter = parseStatusFilter(estado);
  const loans = await listLoansForAdmin({ db: getDb() }, { status: statusFilter });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Préstamos</h1>
          <p className="text-sm text-ink-muted">
            {statusFilter
              ? `Filtrando por ${loanStatusLabel(statusFilter).toLowerCase()}`
              : "Todos los préstamos, más recientes primero"}
          </p>
        </div>
        <p className="text-sm text-ink-muted" aria-live="polite">
          {loans.length} resultado{loans.length === 1 ? "" : "s"}
        </p>
      </div>

      <nav aria-label="Filtrar por estado" className="flex flex-wrap gap-2">
        <Link
          href="/admin/prestamos"
          aria-current={statusFilter ? undefined : "page"}
          className={
            statusFilter
              ? "rounded-full border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink-muted transition-colors hover:border-primary-600 hover:text-ink"
              : "rounded-full border border-primary-600 bg-primary-50 px-3 py-1.5 text-sm font-semibold text-primary-700"
          }
        >
          Todos
        </Link>
        {FILTERABLE_STATUSES.map((status) => {
          const isActive = statusFilter === status;
          return (
            <Link
              key={status}
              href={`/admin/prestamos?estado=${status}`}
              aria-current={isActive ? "page" : undefined}
              className={
                isActive
                  ? "rounded-full border border-primary-600 bg-primary-50 px-3 py-1.5 text-sm font-semibold text-primary-700"
                  : "rounded-full border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink-muted transition-colors hover:border-primary-600 hover:text-ink"
              }
            >
              {loanStatusLabel(status)}
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
                <TableHead>Número</TableHead>
                <TableHead>Capital</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Alta</TableHead>
                <TableHead>Desembolso</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>
                  <span className="sr-only">Acción</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loans.length === 0 ? (
                <TableEmpty colSpan={7}>
                  No hay préstamos en este filtro.
                </TableEmpty>
              ) : (
                loans.map((loan) => (
                  <TableRow key={loan.id}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {loan.loanNumber ?? loan.id}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatPesosOrDash(loan.principalPesos)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-ink-muted">
                      {loan.pricing
                        ? `${loan.pricing.termInstallments} × ${termFrequencyLabel(
                            loan.pricing.termFrequency,
                          )}`
                        : loan.principalPesos === undefined
                          ? "Sin datos"
                          : "Sin plan"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-ink-muted">
                      {formatDateTime(loan.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-ink-muted">
                      {formatDateTime(loan.disbursedAt)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={loanStatusTone(loan.status)}>
                        {loanStatusLabel(loan.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/admin/prestamos/${loan.id}`}
                        className="text-sm font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-800"
                      >
                        Ver
                      </Link>
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
