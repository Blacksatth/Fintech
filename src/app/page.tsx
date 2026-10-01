import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { Role } from "@/server/types";
import { AppHeader, type NavItem } from "@/components/layout/app-header";
import { ClientDashboard } from "@/components/client/client-dashboard";
import { loadClientDashboard } from "@/services/credit/client-dashboard-service";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  LinkButton,
  Stat,
} from "@/components/ui";

/** Los mismos enlaces de la cabecera, para quien entra por la portada. */
const NAV_SESION: NavItem[] = [
  { href: "/", label: "Inicio" },
  { href: "/solicitar", label: "Solicitar préstamo" },
  { href: "/mis-solicitudes", label: "Mis solicitudes" },
  { href: "/mis-prestamos", label: "Mis préstamos" },
  { href: "/mis-notificaciones", label: "Notificaciones" },
];

interface Destino {
  href: string;
  titulo: string;
  descripcion: string;
  cta: string;
}

const CLIENTE: Destino[] = [
  {
    href: "/solicitar",
    titulo: "Solicitar préstamo",
    descripcion: "Pide un microcrédito en pesos. La solicitud se puntúa al instante y el administrador la revisa.",
    cta: "Nueva solicitud",
  },
  {
    href: "/mis-solicitudes",
    titulo: "Mis solicitudes",
    descripcion: "Estado y puntaje de cada solicitud que has enviado, con el motivo cuando el administrador lo rechaza.",
    cta: "Ver solicitudes",
  },
  {
    href: "/mis-prestamos",
    titulo: "Mis préstamos",
    descripcion: "Saldo, calendario de cuotas, pagos registrados y comprobantes de cada préstamo.",
    cta: "Ver préstamos",
  },
];

const ADMIN: Destino[] = [
  {
    href: "/admin/loan-applications",
    titulo: "Solicitudes",
    descripcion: "Puntúa, aprueba o rechaza las solicitudes pendientes.",
    cta: "Abrir cola",
  },
  {
    href: "/admin/prestamos",
    titulo: "Préstamos",
    descripcion: "Cartera desembolsada y la confirmación de cada desembolso.",
    cta: "Abrir cartera",
  },
  {
    href: "/admin/pagos",
    titulo: "Pagos",
    descripcion: "Pagos que esperan revisión: confirmar, rechazar o revertir con motivo.",
    cta: "Revisar pagos",
  },
  {
    href: "/admin/mora",
    titulo: "Cartera de mora",
    descripcion: "Cuotas vencidas y próximas a vencer, con días de atraso y recálculo de la cartera.",
    cta: "Ver mora",
  },
];

function DestinoCard({ destino }: { destino: Destino }) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>{destino.titulo}</CardTitle>
        <CardDescription>{destino.descripcion}</CardDescription>
      </CardHeader>
      <CardContent className="mt-auto">
        <LinkButton href={destino.href} variant="secondary" size="sm">
          {destino.cta}
        </LinkButton>
      </CardContent>
    </Card>
  );
}

/**
 * Portada con dos caras: la pública (explica el producto e invita a entrar) y, si ya hay sesión,
 * el **hub** de la aplicación con un botón para cada área a la que el usuario tiene acceso.
 *
 * El hub se decide en el servidor y no en el cliente a propósito: el rol viene de la cookie de
 * sesión, y decidirlo en el navegador haría que la navegación mostrara enlaces que al pulsarlos
 * devuelven 403.
 */
export default async function Home() {
  const cookieStore = await cookies();
  const db = getDb();

  const context = await requireUser({ auth: getAuthAdmin(), db, cookies: cookieStore }).catch(() => null);
  const esAdmin = context?.role === Role.ADMIN;

  if (!context) {
    return (
      <div className="flex min-h-full flex-1 flex-col">
        <AppHeader />

        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10">
          <section className="flex flex-col items-start gap-4">
            <Badge tone="primary">Beta · Firebase real</Badge>
            <h1 className="max-w-xl text-3xl font-bold leading-tight tracking-tight text-ink sm:text-4xl">
              Microcréditos simples, transparentes y en pesos.
            </h1>
            <p className="max-w-xl text-ink-muted">
              Plataforma para desembolsos, cobranza y seguimiento de cartera pensada para Colombia:
              montos enteros, reglas claras y un flujo auditable de principio a fin.
            </p>
            <div className="flex flex-wrap gap-3">
              <LinkButton href="/registro">Crear cuenta</LinkButton>
              <LinkButton href="/login" variant="secondary">
                Ingresar
              </LinkButton>
            </div>
          </section>

          <section aria-label="Resumen de cartera" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label="Capital desembolsado" valuePesos={12_850_000} meta="Ciclo actual" tone="primary" />
            <Stat label="Cartera vigente" valuePesos={8_140_000} meta="Rezagos: 2" tone="warning" />
            <Stat label="Cuota al día" valuePesos={3_420_000} meta="Pagos este mes" tone="success" />
          </section>

          <section aria-label="Características" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card>
              <CardContent className="flex flex-col items-start gap-2">
                <Badge tone="neutral">Moneda</Badge>
                <h2 className="font-semibold text-ink">Pesos enteros, sin decimales</h2>
                <p className="text-sm text-ink-muted">
                  Todos los montos se manejan como pesos enteros COP; nunca floats ni céntimos.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex flex-col items-start gap-2">
                <Badge tone="info">Auditoría</Badge>
                <h2 className="font-semibold text-ink">Todo queda registrado</h2>
                <p className="text-sm text-ink-muted">
                  Cada operación de dinero se idempotente y genera un registro de auditoría.
                </p>
              </CardContent>
            </Card>
          </section>
        </main>

        <footer className="border-t border-border bg-surface">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-6 text-sm text-ink-subtle">
            <span>© 2026 Microcrédito</span>
            <span className="hidden sm:inline">Hecho para Colombia · COP</span>
          </div>
        </footer>
      </div>
    );
  }

  if (esAdmin) {
    return (
      <div className="flex min-h-full flex-1 flex-col">
        <AppHeader nav={NAV_SESION} badge="Administración" />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8">
          <section className="flex flex-col items-start gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-ink">
                Hola{context.email ? `, ${context.email}` : ""}
              </h1>
              {esAdmin ? <Badge tone="primary">Administrador</Badge> : <Badge tone="neutral">Cliente</Badge>}
            </div>
            <p className="text-sm text-ink-muted">
              Todo lo que puedes hacer aquí, en un solo lugar. Los pagos los confirma una persona: cuando
              registras uno queda en revisión hasta que el administrador lo apruebe.
            </p>
          </section>

          <section aria-labelledby="titulo-cliente" className="flex flex-col gap-4">
            <h2 id="titulo-cliente" className="text-lg font-semibold text-ink">
              Como cliente
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {CLIENTE.map((destino) => (
                <DestinoCard key={destino.href} destino={destino} />
              ))}
            </div>
          </section>

          <section aria-labelledby="titulo-admin" className="flex flex-col gap-4">
            <h2 id="titulo-admin" className="text-lg font-semibold text-ink">
              Administración
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {ADMIN.map((destino) => (
                <DestinoCard key={destino.href} destino={destino} />
              ))}
            </div>
          </section>
        </main>
      </div>
    );
  }

  // Cliente: el dashboard con su estado financiero (F12). El snapshot se lee en SOLO lectura;
  // abrir la portada no escribe en Firestore (misma regla que la cartera de mora de F11).
  const snapshot = await loadClientDashboard({ db }, context.uid);
  const userSnap = await db.collection("users").doc(context.uid).get();
  const fullName = (userSnap.data() as { fullName?: string } | undefined)?.fullName ?? null;
  const userName = fullName ?? context.email ?? "cliente";

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <AppHeader nav={NAV_SESION} />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-8">
        <ClientDashboard userName={userName} snapshot={snapshot} />
      </main>
    </div>
  );
}
