import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form";

export const metadata: Metadata = {
  title: "Ingresar",
  description: "Inicia sesión para.ver tus créditos y pagos.",
};

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-12">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-ink">Microcrédito</h1>
        <p className="text-sm text-ink-muted">
          Entra con el correo con el que te registraste. Tu contraseña nunca pasa por nuestros servidores.
        </p>
      </div>
      <AuthForm mode="login" />
    </main>
  );
}
