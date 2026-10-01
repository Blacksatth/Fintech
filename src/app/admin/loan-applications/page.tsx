import Link from "next/link";
import { getDb } from "@/lib/admin";
import { type ApplicationStatus } from "@/server/types";
import { listApplicationsForAdmin } from "@/services/credit/admin-application-service";
import { formatPesos } from "@/server/money";
import {
  applicationStatusLabel,
  applicationStatusTone,
  formatDateTime,
  shortUid,
  termFrequencyLabel,
} from "@/lib/credit-labels";
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui";

const FILTERABLE_STATUSES: readonly ApplicationStatus[] = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "DRAFT",
];

const FILTER_VALUES = new Set<string>(FILTERABLE_STATUSES);

/** Solo acepta un estado conocido: la URL es entrada de usuario. */
function parseStatusFilter(value: string | string[] | undefined): ApplicationStatus | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !FILTER_VALUES.has(raw)) return undefined;
  return raw as ApplicationStatus;
}

export default async function AdminApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { estado } = await searchParams;
  const statusFilter = parseStatusFilter(estado);
  const applications = await listApplicationsForAdmin({ db: getDb() }, { status: statusFilter });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Solicitudes de crédito</h1>
          <p className="text-sm text-ink-muted">
            {statusFilter
              ? `Filtrando por ${applicationStatusLabel(statusFilter).toLowerCase()}`
              : "Todas las solicitudes, más recientes primero"}
          </p>
        </div>
        <p className="text-sm text-ink-muted" aria-live="polite">
          {applications.length} resultado{applications.length === 1 ? "" : "s"}
        </p>
      </div>

      <nav aria-label="Filtrar por estado" className="flex flex-wrap gap-2">
        <Link
          href="/admin/loan-applications"
          aria-current={statusFilter ? undefined : "page"}
          className={
            statusFilter
              ? "rounded-full border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink-muted transition-colors hover:border-primary-600 hover:text-ink"
              : "rounded-full border border-primary-600 bg-primary-50 px-3 py-1.5 text-sm font-semibold text-primary-700"
          }
        >
          Todas
        </Link>
        {FILTERABLE_STATUSES.map((status) => {
          const isActive = statusFilter === status;
          return (
            <Link
              key={status}
              href={`/admin/loan-applications?estado=${status}`}
              aria-current={isActive ? "page" : undefined}
              className={
                isActive
                  ? "rounded-full border border-primary-600 bg-primary-50 px-3 py-1.5 text-sm font-semibold text-primary-700"
                  : "rounded-full border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink-muted transition-colors hover:border-primary-600 hover:text-ink"
              }
            >
              {applicationStatusLabel(status)}
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
                <TableHead>Solicitante</TableHead>
                <TableHead>Monto</TableHead>
                <TableHead>Cuotas</TableHead>
                <TableHead>Presentada</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>
                  <span className="sr-only">Acción</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {applications.length === 0 ? (
                <TableEmpty colSpan={7}>
                  No hay solicitudes en este filtro.
                </TableEmpty>
              ) : (
                applications.map((application) => (
                  <TableRow key={application.id}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {application.applicationNumber}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-ink-muted">
                      {shortUid(application.userId)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatPesos(application.requestedAmountPesos)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {application.termInstallments} × {termFrequencyLabel(application.termFrequency)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-ink-muted">
                      {formatDateTime(application.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={applicationStatusTone(application.status)}>
                        {applicationStatusLabel(application.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/admin/loan-applications/${application.id}`}
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
