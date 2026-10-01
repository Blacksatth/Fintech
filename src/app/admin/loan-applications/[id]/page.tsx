import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/admin";
import { getApplicationForReview } from "@/services/credit/admin-application-service";
import {
  applicationStatusLabel,
  applicationStatusTone,
  formatDateTime,
  isDecidableStatus,
  monthlyIncomeLabel,
  termFrequencyLabel,
  toDate,
} from "@/lib/credit-labels";
import { ScoreExplanationPanel } from "@/components/credit/score-explanation-panel";
import { ApplicationDecisionActions } from "@/components/admin/application-decision-actions";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Stat } from "@/components/ui";

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium tracking-wide text-ink-subtle uppercase">{label}</dt>
      <dd className="text-sm text-ink break-words">{value ?? "—"}</dd>
    </div>
  );
}

export default async function AdminApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const review = await getApplicationForReview({ db: getDb() }, id);
  if (!review) notFound();

  const { application, applicant, score } = review;
  const decided = !isDecidableStatus(application.status);
  const riskLevel = (score?.riskLevel ?? "MEDIUM") as "LOW" | "MEDIUM" | "HIGH";
  const reviewedAt = toDate(application.reviewedAt);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/admin/loan-applications"
            className="text-sm font-medium text-primary-700 underline underline-offset-2 hover:text-primary-800"
          >
            Volver a solicitudes
          </Link>
          <h1 className="mt-1 font-mono text-2xl font-bold text-ink">{application.applicationNumber}</h1>
          <p className="text-sm text-ink-muted">
            Presentada el {formatDateTime(application.createdAt)} ·{" "}
            {application.termInstallments} cuotas {termFrequencyLabel(application.termFrequency).toLowerCase()}
          </p>
        </div>
        <Badge tone={applicationStatusTone(application.status)} className="text-sm">
          {applicationStatusLabel(application.status)}
        </Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Monto solicitado" valuePesos={application.requestedAmountPesos} />
        <Card>
          <CardContent className="flex h-full flex-col justify-center gap-0.5">
            <span className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
              Score de riesgo
            </span>
            <span className="text-2xl font-bold text-ink font-mono">
              {score ? `${score.score}/100` : "—"}
            </span>
            <span className="text-sm text-ink-muted">
              {score ? "Calculado" : "Sin score calculado"}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex h-full flex-col justify-center gap-0.5">
            <span className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
              Producto
            </span>
            <span className="text-sm font-medium text-ink break-words">{application.productId}</span>
            <span className="text-sm text-ink-muted">
              {application.termInstallments} × {termFrequencyLabel(application.termFrequency)}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex h-full flex-col justify-center gap-0.5">
            <span className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
              Última actualización
            </span>
            <span className="text-sm font-medium text-ink">
              {formatDateTime(application.updatedAt)}
            </span>
            <span className="text-sm text-ink-muted">
              Alta {formatDateTime(applicant.user?.createdAt ?? null)}
            </span>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Solicitante</CardTitle>
          <CardDescription>Datos de la persona que presentó la solicitud.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Nombre" value={applicant.user?.fullName ?? null} />
            <Field label="Correo" value={applicant.user?.email ?? null} />
            <Field label="Teléfono" value={applicant.user?.phone ?? null} />
            <Field label="Ciudad" value={applicant.profile?.city ?? null} />
            <Field label="Ocupación" value={applicant.profile?.occupation ?? null} />
            <Field label="Ingreso mensual" value={monthlyIncomeLabel(applicant.profile?.monthlyIncomeRange)} />
            <Field label="Alta en el sistema" value={formatDateTime(applicant.user?.createdAt ?? null)} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Score crediticio</CardTitle>
          <CardDescription>
            {score
              ? `Calculado el ${formatDateTime(score.calculatedAt)}.`
              : "Esta solicitud no tiene score calculado, así que no se puede aprobar."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {score ? (
            <ScoreExplanationPanel
              score={score.score}
              riskLevel={riskLevel}
              factors={score.factors}
              modelVersion={score.modelVersion}
            />
          ) : (
            <p className="rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning">
              <strong className="font-semibold">Sin score.</strong> El motor de scoring no dejó
              registro para esta solicitud, así que el servidor rechazará un approve con un
              conflicto de estado.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Decisión</CardTitle>
          <CardDescription>
            {decided
              ? `Decidida el ${reviewedAt ? formatDateTime(reviewedAt) : "—"}.`
              : "La decisión requiere confirmación y siempre queda auditada."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {decided ? (
            <div className="flex flex-col gap-3">
              <dl className="grid gap-4 sm:grid-cols-2">
                <Field label="Estado" value={applicationStatusLabel(application.status)} />
                <Field label="Revisada por" value={application.reviewedBy ?? null} />
                <Field label="Fecha de decisión" value={formatDateTime(application.reviewedAt)} />
              </dl>
              <Field label="Notas de la decisión" value={application.decisionNotes ?? null} />
            </div>
          ) : (
            <ApplicationDecisionActions
              applicationId={application.id}
              applicationNumber={application.applicationNumber}
              requestedAmountPesos={application.requestedAmountPesos}
              hasScore={score !== null}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
