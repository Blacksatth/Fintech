import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form";

export const metadata: Metadata = {
  title: "Crear cuenta",
  description: "Crea tu cuenta para solicitar y seguir tu microcrédito.",
};

export default function RegistroPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-12">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-ink">Crea tu cuenta</h1>
        <p className="text-sm text-ink-muted">
          Tu correo y tu contraseña se procesan en Firebase Auth; nosotros solo guardamos tu token de sesión.
        </p>
      </div>
      <AuthForm mode="registro" />
    </main>
  );
}
