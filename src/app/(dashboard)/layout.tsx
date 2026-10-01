import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { redirect } from "next/navigation";
import { AppHeader, type NavItem } from "@/components/layout/app-header";
import { Role } from "@/server/types";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const db = getDb();
  const auth = getAuthAdmin();

  let context;
  try {
    context = await requireUser({ auth, db, cookies: cookieStore });
  } catch {
    redirect("/login");
  }

  const nav: NavItem[] = [
    { href: "/", label: "Inicio" },
    { href: "/solicitar", label: "Solicitar préstamo" },
    { href: "/mis-solicitudes", label: "Mis solicitudes" },
    { href: "/mis-prestamos", label: "Mis préstamos" },
    { href: "/mis-notificaciones", label: "Notificaciones" },
  ];
  // Un ADMIN también es cliente: el enlace evita que tenga que escribir la URL para volver a su
  // sección (y la cabecera del área admin lo devuelve aquí con "Inicio").
  if (context.role === Role.ADMIN) {
    nav.push({ href: "/admin/loan-applications", label: "Administración" });
  }

  return (
    <div className="flex min-h-screen flex-col bg-surface-muted">
      <AppHeader nav={nav} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
