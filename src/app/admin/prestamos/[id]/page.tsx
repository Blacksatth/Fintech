import Link from "next/link";
import { getDb } from "@/lib/admin";
import { getLoanForDisbursement } from "@/services/credit/admin-loan-service";
import { rethrowAsNotFound } from "@/lib/next-not-found";
import { formatPesos, formatPesosOrDash } from "@/server/money";
import {
  disbursementStatusLabel,
  disbursementStatusTone,
  formatDateTime,
  installmentStatusLabels,
  installmentStatusTones,
  loanStatusLabel,
  loanStatusTone,
  termFrequencyLabel,
} from "@/lib/credit-labels";
import { DisbursementActions } from "@/components/admin/disbursement-actions";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
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

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium tracking-wide text-ink-subtle uppercase">{label}</dt>
      <dd className="text-sm text-ink break-words">{value ?? "—"}</dd>
    </div>
  );
}

/**
 * `Stat` exige un entero seguro, y hay documentos de `loans` anteriores al esquema que solo
 * guardan `userId/status/createdAt`. Para esos se muestra el mismo bloque con "—": la pantalla
 * se puede leer y el admin ve que no hay importe, en vez de un 500.
 */
function AmountStat({ label, pesos }: { label: string; pesos: number | undefined }) {
  if (typeof pesos === "number" && Number.isSafeInteger(pesos)) {
    return <Stat label={label} valuePesos={pesos} />;
  }
  return (
    <Card>
      <CardContent className="flex h-full flex-col justify-center gap-0.5">
        <span className="text-xs font-medium tracking-wide text-ink-subtle uppercase">{label}</span>
        <span className="text-2xl font-bold text-ink font-mono">—</span>
        <span className="text-sm text-ink-muted">Sin importe registrado</span>
      </CardContent>
    </Card>
  );
}

export default async function AdminLoanDisbursementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // El servicio lanza `notFound` si el préstamo no existe; sin traducirlo, la página reventaría con
  // un 500 en vez de mostrar la 404 del área de administración.
  const { loan, installments, disbursement, holder } = await getLoanForDisbursement(
    { db: getDb() },
    id,
  ).catch(rethrowAsNotFound);

  const pricing = loan.pricing;
  // Mismo motivo que en el servicio: sin snapshot el servidor no puede re-programar el
  // calendario, así que la pantalla avisa antes de que el admin lo descubra con un 409.
  const blockedByMissingPricing = pricing === undefined;
  const status = disbursement?.status ?? "PENDING";
  const confirmed = status === "CONFIRMED";
  const initiated = status === "INITIATED";
  // Los documentos anteriores al esquema no tienen `loanNumber`: se identifican por su id.
  const loanLabel = loan.loanNumber ?? loan.id;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/admin/prestamos"
            className="text-sm font-medium text-primary-700 underline underline-offset-2 hover:text-primary-800"
          >
            Volver a préstamos
          </Link>
          <h1 className="mt-1 font-mono text-2xl font-bold text-ink">{loanLabel}</h1>
          <p className="text-sm text-ink-muted">
            Alta el {formatDateTime(loan.createdAt)} · {pricing
              ? `${pricing.termInstallments} cuotas ${termFrequencyLabel(pricing.termFrequency).toLowerCase()}`
              : "sin plan vigente"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={loanStatusTone(loan.status)} className="text-sm">
            {loanStatusLabel(loan.status)}
          </Badge>
          <Badge tone={disbursementStatusTone(status)} className="text-sm">
            {disbursementStatusLabel(status)}
          </Badge>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <AmountStat label="Capital a transferir" pesos={loan.principalPesos} />
        <AmountStat label="Interés" pesos={loan.interestPesos} />
        <AmountStat label="Total a pagar" pesos={loan.totalPayablePesos} />
        <Card>
          <CardContent className="flex h-full flex-col justify-center gap-0.5">
            <span className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
              Titular
            </span>
            <span className="text-sm font-medium text-ink break-words">
              {holder?.fullName ?? "—"}
            </span>
            <span className="text-sm text-ink-muted break-words">{holder?.email ?? "—"}</span>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Condiciones del préstamo</CardTitle>
          <CardDescription>
            Snapshot vigente con el que el cliente aceptó. Es la única fuente para re-programar los
            vencimientos.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pricing ? (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Producto" value={loan.productCode ?? null} />
              <Field
                label="Tasa anual"
                value={`${(pricing.annualRateBps / 100).toFixed(2)}%`}
              />
              <Field label="Cargo por gestión" value={`${(pricing.effectiveFeeBps / 100).toFixed(2)}%`} />
              <Field label="Cuotas" value={`${pricing.termInstallments} × ${termFrequencyLabel(pricing.termFrequency)}`} />
              <Field label="Interés" value={formatPesosOrDash(loan.interestPesos)} />
              <Field label="Cargo" value={formatPesosOrDash(loan.feePesos)} />
            </dl>
          ) : (
            <p className="rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning">
              <strong className="font-semibold">Sin datos económicos completos.</strong> A este
              préstamo le falta el snapshot <code>pricing</code>{" "}
              {loan.principalPesos === undefined
                ? "y sus importes: es un documento anterior al esquema actual, no un préstamo operable."
                : "porque es anterior a la migración, así que no registra con qué condiciones se aprobó."}{" "}
              El servidor no puede re-programar su calendario sin esos datos, y no se inventa una
              tasa: eso sería cambiar lo que el cliente aceptó.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Desembolso</CardTitle>
          <CardDescription>
            {confirmed
              ? "Confirmado. La transferencia ya es un hecho: el préstamo quedó desembolsado y sus vencimientos se fijaron desde la fecha de confirmación."
              : initiated
                ? "Referencia registrada y pendiente de confirmar. Confirmar marca el préstamo como desembolsado y fija los vencimientos desde hoy."
                : "Todavía no se ha registrado ninguna transferencia. Iniciar deja constancia de la referencia; el préstamo no se mueve hasta que confirmes."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {confirmed || initiated ? (
            <dl className="grid gap-4 sm:grid-cols-2">
              <Field label="Referencia" value={disbursement?.reference ?? null} />
              <Field
                label={confirmed ? "Confirmado por" : "Iniciado por"}
                value={confirmed ? (disbursement?.confirmedBy ?? null) : (disbursement?.initiatedBy ?? null)}
              />
              <Field
                label={confirmed ? "Fecha de confirmación" : "Fecha de inicio"}
                value={formatDateTime(confirmed ? (disbursement?.confirmedAt ?? null) : (disbursement?.initiatedAt ?? null))}
              />
              <Field label="Desembolsado el" value={formatDateTime(loan.disbursedAt)} />
            </dl>
          ) : null}

          {confirmed ? (
            <p className="rounded-md border border-success bg-success-bg p-3 text-sm text-success">
              <strong className="font-semibold">Listo.</strong> No queda nada por hacer aquí: el pago
              se confirma desde la pantalla del cliente.
            </p>
          ) : (
            <DisbursementActions
              loanId={loan.id}
              loanNumber={loanLabel}
              principalPesos={loan.principalPesos}
              disbursementStatus={status}
              reference={disbursement?.reference ?? null}
              blockedByMissingPricing={blockedByMissingPricing}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plan de pagos</CardTitle>
          <CardDescription>
            {confirmed
              ? `Vencimientos fijados desde el desembolso.`
              : "Todavía son las fechas provisionadas de la solicitud: se re-programan desde hoy al confirmar."}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Vencimiento</TableHead>
                <TableHead>Capital</TableHead>
                <TableHead>Interés</TableHead>
                <TableHead>Cargo</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Pagado</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {installments.length === 0 ? (
                <TableEmpty colSpan={8}>
                  Este préstamo no tiene cuotas registradas.
                </TableEmpty>
              ) : (
                installments.map((installment) => (
                  <TableRow key={installment.installmentNumber}>
                    <TableCell className="font-mono text-xs">{installment.installmentNumber}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(installment.dueDate)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatPesos(installment.principalPesos)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatPesos(installment.interestPesos)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatPesos(installment.feePesos)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-medium">
                      {formatPesos(installment.totalPesos)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatPesos(installment.paidPesos)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={installmentStatusTones[installment.status]}>
                        {installmentStatusLabels[installment.status]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-ink-subtle">
        Último cambio del préstamo: {formatDateTime(loan.updatedAt)} · estado de mora:{" "}
        {loan.delinquencyStatus ?? "—"}
      </p>
    </div>
  );
}
