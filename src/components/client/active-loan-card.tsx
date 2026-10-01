import type { ClientDashboardSnapshot } from "@/server/client-dashboard";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/link-button";
import { formatPesos } from "@/server/money";
import {
  delinquencyStatusLabel,
  delinquencyStatusTone,
  formatDueDate,
  loanStatusLabel,
  loanStatusTone,
} from "@/lib/credit-labels";
import { DelinquencyStatus, LoanStatus } from "@/server/types";

/**
 * Pieza central del dashboard: el estado financiero del cliente en una sola tarjeta.
 *
 * Estado vacío (sin préstamos), sin préstamo activo (historia presente) o préstamo activo con
 * saldo, próxima cuota, progreso de pagos y el camino para pagar. La mora mostrada es la caché
 * de `loans` (la misma que recalcula el admin y que "Recalcular cartera" mantiene al día).
 */
export function ActiveLoanCard({ snapshot }: { snapshot: ClientDashboardSnapshot }) {
  if (snapshot.mode === "no_loans") {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-10">
          <h2 className="text-xl font-bold tracking-tight text-ink">Solicita tu primer préstamo</h2>
          <p className="max-w-prose text-sm text-ink-muted">
            Anímate con un microcrédito en pesos: montos enteros, reglas claras y cuotas fijas
            desde el día en que lo aceptas. Cuando el administrador lo apruebe y desembolse,
            aquí verás tu saldo y tu próxima cuota.
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            <LinkButton href="/solicitar">Solicitar préstamo</LinkButton>
            <LinkButton href="/mis-solicitudes" variant="secondary">
              Ver mis solicitudes
            </LinkButton>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (snapshot.mode === "no_active") {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-10">
          <h2 className="text-xl font-bold tracking-tight text-ink">No tienes un préstamo activo</h2>
          {snapshot.lastLoan ? (
            <p className="max-w-prose text-sm text-ink-muted">
              Tu último préstamo{" "}
              <span className="font-medium text-ink">{snapshot.lastLoan.loanNumber}</span>{" "}
              está <Badge tone={loanStatusTone(snapshot.lastLoan.status)}>
                {loanStatusLabel(snapshot.lastLoan.status)}
              </Badge>
              . Si lo pagaste por completo, el cupo vuelve a estar disponible.
            </p>
          ) : (
            <p className="max-w-prose text-sm text-ink-muted">
              Cuando tengas un préstamo desembolsado aparecerá aquí su saldo y su próxima cuota.
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-3">
            <LinkButton href="/solicitar">Solicitar préstamo</LinkButton>
            <LinkButton href="/mis-prestamos" variant="secondary">
              Ver historial
            </LinkButton>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { activeLoan: loan, next, paidInstallments, installmentCount, canRegisterPayment } = snapshot;
  const enTramite = loan.status === LoanStatus.PENDING_DISBURSEMENT;
  const progreso = installmentCount > 0 ? Math.round((paidInstallments / installmentCount) * 100) : 0;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold tracking-tight text-ink">{loan.loanNumber}</h2>
          <Badge tone={loanStatusTone(loan.status)}>{loanStatusLabel(loan.status)}</Badge>
          {loan.delinquencyStatus !== DelinquencyStatus.CURRENT ? (
            <Badge tone={delinquencyStatusTone(loan.delinquencyStatus)}>
              {delinquencyStatusLabel(loan.delinquencyStatus)}
            </Badge>
          ) : null}
        </div>
        <LinkButton href={`/mis-prestamos/${loan.id}`} variant="secondary" size="sm">
          Ver préstamo
        </LinkButton>
      </CardHeader>

      <CardContent className="space-y-5">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-ink-muted">{enTramite ? "Por desembolsar" : "Saldo pendiente"}</dt>
            <dd className="mt-1 text-3xl font-semibold tabular-nums text-ink">
              {formatPesos(loan.outstandingPesos)}
            </dd>
            <dd className="mt-1 text-xs text-ink-subtle">
              de {formatPesos(loan.totalPayablePesos)} a pagar en total
            </dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">Próxima cuota</dt>
            {next ? (
              <>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-ink">
                  {formatPesos(next.totalPesos)}
                </dd>
                <dd className="mt-1 text-xs text-ink-muted">
                  <time dateTime={next.dueDateIso}>{formatDueDate(next.dueDateIso)}</time>
                  {" · "}
                  {next.daysUntil < 0 ? (
                    <span className="font-medium text-danger">
                      Vencida hace {Math.abs(next.daysUntil)} día{Math.abs(next.daysUntil) === 1 ? "" : "s"}
                    </span>
                  ) : next.daysUntil === 0 ? (
                    <span className="font-medium text-warning">Vence hoy</span>
                  ) : (
                    <span>
                      Vence en {next.daysUntil} día{next.daysUntil === 1 ? "" : "s"}
                    </span>
                  )}
                </dd>
              </>
            ) : (
              <dd className="mt-1 font-medium text-ink">Sin cuotas pendientes</dd>
            )}
          </div>
        </dl>

        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span className="text-ink-muted">Cuotas pagadas</span>
            <span className="font-medium tabular-nums text-ink">
              {paidInstallments} de {installmentCount}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={`Cuotas pagadas: ${paidInstallments} de ${installmentCount} (${progreso}%)`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progreso}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
          >
            <div className="h-full rounded-full bg-primary-600" style={{ width: `${progreso}%` }} />
          </div>
        </div>

        {enTramite ? (
          <p className="text-sm text-ink-muted">
            Este préstamo está listo: el administrador confirmará el desembolso y el calendario de
            cuotas se ajusta a esa fecha (decisión de F9).
          </p>
        ) : null}

        {canRegisterPayment ? (
          <div className="flex flex-wrap gap-3">
            <LinkButton href={`/mis-prestamos/${loan.id}`}>Registrar pago</LinkButton>
            <span className="inline-flex items-center text-xs text-ink-subtle">
              El pago queda en revisión hasta que el administrador lo confirme.
            </span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}