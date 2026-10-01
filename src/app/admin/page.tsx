import Link from "next/link";
import { getDb } from "@/lib/admin";
import { getPortfolioMetrics } from "@/services/credit/portfolio-service";
import { getApplicationFunnel } from "@/services/admin/application-funnel-service";
import { getAdminPending } from "@/services/admin/admin-pending-service";
import { formatRateBps } from "@/lib/credit-labels";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Stat } from "@/components/ui";

/**
 * Panel de administración (F13 / F13-2a + F13-2b).
 *
 * Orden deliberado: **lo que hay que hacer primero**, después los números. Un panel que arranca con
 * catorce ceros no dice si el admin tiene trabajo pendiente; este abre con la cola y sigue con la
 * cartera.
 *
 * De dónde sale cada número: la cartera se lee de la caché de `loans` (lo que escribieron los
 * servicios de pago y recálculo, no un cálculo al vuelo) y el embudo, de `loan_applications`. Cuando
 * no hay préstamos el panel lo dice explícitamente en vez de mostrar una cuadrícula de ceros que
 * parece un error, porque el trabajo del admin ocurre antes: en las solicitudes.
 */
export default async function AdminPanelPage() {
  const db = getDb();
  const [{ metrics, truncated, skippedLegacy }, funnel, pending] = await Promise.all([
    getPortfolioMetrics({ db }),
    getApplicationFunnel({ db }),
    getAdminPending({ db }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Panel</h1>
        <p className="text-sm text-ink-muted">
          {funnel.total > 0
            ? `${funnel.total} solicitud${funnel.total === 1 ? "" : "es"} en el sistema · cartera a la fecha de la última actualización`
            : "Cartera a la fecha de la última actualización"}
        </p>
      </div>

      {/* 1. Lo accionable. Cada tarjeta abre la sección donde se resuelve. */}
      {pending.items.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Tu cola</CardTitle>
            <CardDescription>
              {pending.total} {pending.total === 1 ? "decisión esperando" : "decisiones esperando"}. Todo
              aquí exige una confirmación humana.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {pending.items.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  className="rounded-lg border border-border p-4 transition-colors hover:border-primary-600 hover:bg-surface-muted"
                >
                  <p className="text-xs text-ink-muted">{item.label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
                    {item.count}
                    {item.truncated ? "+" : ""}
                  </p>
                  <p className="mt-1 text-xs text-ink-subtle">{item.description}</p>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Tu cola</CardTitle>
            <CardDescription>Nada esperando decisión: sin solicitudes por revisar, pagos por confirmar ni préstamos por desembolsar.</CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* 2. Embudo: dónde están las solicitudes hoy. */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>Solicitudes</CardTitle>
              <CardDescription>Dónde está cada solicitud del embudo</CardDescription>
            </div>
            <Link href="/admin/loan-applications" className="text-sm font-medium text-primary-700 hover:underline">
              Ver solicitudes
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {funnel.byStatus.length === 0 ? (
            <p className="text-sm text-ink-muted">Todavía no hay solicitudes registradas.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {funnel.byStatus.map((row) => (
                <Link
                  key={row.status}
                  href="/admin/loan-applications"
                  className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:border-primary-600 hover:bg-surface-muted"
                >
                  <span className="text-ink-muted">{row.label}</span>
                  <span className="font-semibold tabular-nums text-ink">{row.count}</span>
                </Link>
              ))}
            </div>
          )}
          {funnel.truncated ? (
            <p role="status" className="mt-3 rounded-lg border border-warning/30 bg-warning-bg p-3 text-xs text-warning">
              Algún estado superó el tope de lectura: estas cifras son un piso, no el total.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* 3. Cartera. Solo tiene sentido cuando existe. */}
      {metrics.prestamosActivos > 0 || metrics.desembolsadoAcumuladoPesos > 0 ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Estado de la cartera</CardTitle>
              <CardDescription>Saldo por cobrar, particionado entre vigente y vencida</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Cartera por cobrar" valuePesos={metrics.carteraTotalPesos} />
                <Stat label="Vigente" valuePesos={metrics.vigentePesos} tone="success" />
                <Stat label="Vencida" valuePesos={metrics.vencidaPesos} tone="warning" />
                <Stat
                  label="En mora"
                  valuePesos={metrics.enMoraPesos}
                  meta={`${formatRateBps(metrics.tasaMoraBps)} de la cartera`}
                  tone="danger"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cobrado y confiado</CardTitle>
              <CardDescription>
                Flujo histórico: lo desembolsado, lo recuperado y lo que queda por cobrar
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Desembolsado acumulado"
                  valuePesos={metrics.desembolsadoAcumuladoPesos}
                  meta={`${metrics.prestamosPagados} préstamo${metrics.prestamosPagados === 1 ? "" : "s"} pagado${metrics.prestamosPagados === 1 ? "" : "s"}`}
                />
                <Stat
                  label="Recuperado acumulado"
                  valuePesos={metrics.recuperadoAcumuladoPesos}
                  meta={`${formatRateBps(metrics.tasaRecuperacionBps)} de lo confiado en efectivo`}
                  tone="success"
                />
                <Stat label="Saldo pendiente" valuePesos={metrics.saldoPendientePesos} />
                <Stat
                  label="Pérdida de cartera"
                  valuePesos={metrics.perdidaCarteraPesos}
                  meta={`${metrics.prestamosIncumplidos} incumplido${metrics.prestamosIncumplidos === 1 ? "" : "s"}`}
                  tone="warning"
                />
              </div>
              <p className="mt-4 text-sm text-ink-muted">
                Rendimiento pactado del contrato sobre el principal:{" "}
                <span className="font-semibold text-ink">{formatRateBps(metrics.rendimientoBps)}</span>
                {" · "}
                Mayor atraso registrado{" "}
                {metrics.maxDaysPastDue === 0
                  ? "sin vencidos"
                  : `${metrics.maxDaysPastDue} día${metrics.maxDaysPastDue === 1 ? "" : "s"}`}
              </p>
            </CardContent>
          </Card>

          {truncated ? (
            <p role="status" className="rounded-lg border border-warning/30 bg-warning-bg p-3 text-sm text-warning">
              Algunos estados superaron el tope de lectura: estas métricas son un piso y no el total de
              la cartera.
            </p>
          ) : null}
          {skippedLegacy > 0 ? (
            <p className="text-xs text-ink-subtle">
              {skippedLegacy} documento{skippedLegacy === 1 ? "" : "s"} de préstamos sin esquema de
              dinero no se contaron.
            </p>
          ) : null}
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Cartera</CardTitle>
            <CardDescription>Todavía no hay cartera que medir</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-ink-muted">
              No hay préstamos ni desembolsos registrados, así que no hay cartera que mostrar. Las
              solicitudes del embudo de arriba sí existen: el trabajo empieza ahí.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <AdminLink href="/admin/loan-applications">Revisar solicitudes</AdminLink>
              <AdminLink href="/admin/prestamos">Ver préstamos</AdminLink>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 4. Secciones. */}
      <Card>
        <CardHeader>
          <CardTitle>Secciones</CardTitle>
        </CardHeader>
        <CardContent>
          <nav aria-label="Atajos de administración" className="flex flex-wrap gap-2">
            <AdminLink href="/admin/loan-applications">Solicitudes</AdminLink>
            <AdminLink href="/admin/prestamos">Préstamos</AdminLink>
            <AdminLink href="/admin/pagos">Pagos</AdminLink>
            <AdminLink href="/admin/mora">Mora</AdminLink>
            <AdminLink href="/admin/usuarios">Usuarios</AdminLink>
            <AdminLink href="/admin/configuracion">Configuración</AdminLink>
          </nav>
        </CardContent>
      </Card>
    </div>
  );
}

function AdminLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-full border border-border-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:border-primary-600 hover:text-ink"
    >
      {children}
    </Link>
  );
}