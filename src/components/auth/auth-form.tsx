"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  linkWithPopup,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type UserCredential,
} from "firebase/auth";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  useToast,
} from "@/components/ui";
import { getFirebaseWebAuth } from "@/lib/firebase-web";
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULE_TEXT,
  authErrorMessage,
  credentialsSchema,
  profileSchema,
  registrationSchema,
} from "@/server/auth-input";

export type AuthMode = "login" | "registro";

type Pending = "form" | "google" | null;

interface ExchangePayload {
  ok?: boolean;
  profileRequired?: boolean;
  error?: { message?: string };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function googleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<Pending>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pendingProfile, setPendingProfile] = useState<{ idToken: string; fullName: string } | null>(null);

  const isLogin = mode === "login";

  function readForm(form: FormData): { credentials: { email: string; password: string }; fullName: string; phone: string } {
    return {
      credentials: {
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      },
      fullName: String(form.get("fullName") ?? ""),
      phone: String(form.get("phone") ?? ""),
    };
  }

  function fieldIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): Record<string, string> {
    const issues: Record<string, string> = {};
    for (const issue of error.issues) {
      const field = String(issue.path[0] ?? "form");
      if (!(field in issues)) issues[field] = issue.message;
    }
    return issues;
  }

  /** true = sesión lista; false = falta perfil (el componente pide los datos). */
  async function exchange(
    idToken: string,
    profile: { fullName?: string; phone?: string },
  ): Promise<boolean> {
    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken, ...profile }),
    });
    const payload = (await response.json().catch(() => null)) as ExchangePayload | null;
    if (!response.ok) {
      throw new Error(payload?.error?.message ?? "No pudimos iniciar tu sesión.");
    }
    if (payload?.profileRequired) {
      setPendingProfile({ idToken, fullName: profile.fullName ?? "" });
      return false;
    }
    return true;
  }

  function reportSuccess(email: string | null | undefined, message: string) {
    toast("success", message, email ?? undefined);
    router.push("/");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});

    const { credentials, fullName, phone } = readForm(new FormData(event.currentTarget));
    const parsed = isLogin
      ? credentialsSchema.safeParse(credentials)
      : registrationSchema.safeParse({ ...credentials, fullName, phone });

    if (!parsed.success) {
      setFieldErrors(fieldIssues(parsed.error));
      return;
    }

    setPending("form");
    try {
      const auth = getFirebaseWebAuth();
      const credential = isLogin
        ? await signInWithEmailAndPassword(auth, credentials.email, credentials.password)
        : await createUserWithEmailAndPassword(auth, credentials.email, credentials.password);
      const listo = await exchange(await credential.user.getIdToken(), isLogin ? {} : { fullName, phone });
      if (listo) reportSuccess(credential.user.email, isLogin ? "Sesión iniciada" : "Cuenta creada");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : authErrorMessage(errorCode(error)));
    } finally {
      setPending(null);
    }
  }

  async function handleGoogle() {
    setFormError(null);
    setFieldErrors({});
    setPending("google");

    const auth = getFirebaseWebAuth();
    const provider = googleProvider();

    try {
      let credential: UserCredential;
      let vinculado = false;
      try {
        credential = await signInWithPopup(auth, provider);
      } catch (error) {
        if (errorCode(error) !== "auth/account-exists-with-different-credential" || !auth.currentUser) {
          throw error;
        }
        credential = await linkWithPopup(auth.currentUser, provider);
        vinculado = true;
      }

      const fullName = credential.user.displayName ?? "";
      const listo = await exchange(await credential.user.getIdToken(), fullName ? { fullName } : {});
      if (listo) {
        reportSuccess(
          credential.user.email,
          vinculado ? "Google vinculado a tu cuenta" : "Sesión iniciada con Google",
        );
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : authErrorMessage(errorCode(error)));
    } finally {
      setPending(null);
    }
  }

  async function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});
    if (!pendingProfile) return;

    const { fullName, phone } = readForm(new FormData(event.currentTarget));
    const parsed = profileSchema.safeParse({ fullName, phone });
    if (!parsed.success) {
      setFieldErrors(fieldIssues(parsed.error));
      return;
    }

    setPending("form");
    try {
      const listo = await exchange(pendingProfile.idToken, { fullName, phone });
      if (listo) reportSuccess(null, "Perfil completado");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : authErrorMessage(errorCode(error)));
    } finally {
      setPending(null);
    }
  }

  async function cancelProfile() {
    setPendingProfile(null);
    setFormError(null);
    await signOut(getFirebaseWebAuth()).catch(() => undefined);
  }

  if (pendingProfile) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Completa tu perfil</CardTitle>
          <CardDescription>Necesitamos tu nombre y tu teléfono para crear tu usuario.</CardDescription>
        </CardHeader>
        <CardContent>
          <form noValidate onSubmit={handleProfileSubmit} className="flex flex-col gap-4">
            <Input
              label="Nombre completo"
              name="fullName"
              autoComplete="name"
              required
              defaultValue={pendingProfile.fullName}
              error={fieldErrors.fullName}
            />
            <Input
              label="Teléfono"
              name="phone"
              type="tel"
              inputMode="tel"
              placeholder="+573001234567"
              autoComplete="tel"
              required
              error={fieldErrors.phone}
            />
            {formError ? (
              <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                {formError}
              </p>
            ) : null}
            <Button type="submit" loading={pending === "form"}>
              Guardar y continuar
            </Button>
            <button
              type="button"
              onClick={cancelProfile}
              className="text-sm text-ink-muted underline underline-offset-2"
            >
              Cancelar
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isLogin ? "Ingresa a tu cuenta" : "Crea tu cuenta"}</CardTitle>
        <CardDescription>
          {isLogin
            ? "La contraseña se verifica directamente con Firebase; solo recibimos un token de sesión."
            : "Empiezas con los datos básicos de tu perfil."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
          {!isLogin ? (
            <>
              <Input
                label="Nombre completo"
                name="fullName"
                autoComplete="name"
                required
                error={fieldErrors.fullName}
              />
              <Input
                label="Teléfono"
                name="phone"
                type="tel"
                inputMode="tel"
                placeholder="+573001234567"
                autoComplete="tel"
                required
                error={fieldErrors.phone}
              />
            </>
          ) : null}

          <Input
            label="Correo"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            error={fieldErrors.email}
          />
          <Input
            label="Contraseña"
            name="password"
            type="password"
            autoComplete={isLogin ? "current-password" : "new-password"}
            required
            minLength={PASSWORD_MIN_LENGTH}
            hint={isLogin ? undefined : PASSWORD_RULE_TEXT}
            error={fieldErrors.password}
          />

          {formError ? (
            <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          ) : null}

          <Button type="submit" loading={pending === "form"}>
            {isLogin ? "Ingresar" : "Crear cuenta"}
          </Button>

          <div className="flex items-center gap-3" aria-hidden>
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase tracking-wide text-ink-subtle">o</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <Button
            variant="secondary"
            onClick={handleGoogle}
            loading={pending === "google"}
            aria-label="Continuar con Google"
          >
            <GoogleMark />
            Continuar con Google
          </Button>

          <p className="text-center text-sm text-ink-muted">
            {isLogin ? "¿Aún no tienes cuenta?" : "¿Ya tienes cuenta?"}{" "}
            <Link href={isLogin ? "/registro" : "/login"} className="font-medium text-primary-700 underline">
              {isLogin ? "Crear cuenta" : "Ingresar"}
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4" focusable="false">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.54 5.54 0 0 1-2.4 3.63v3.02h3.86c2.26-2.09 3.56-5.17 3.56-8.89Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3.01c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.28v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56V6.63H1.28a12 12 0 0 0 0 10.74l3.99-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.41C17.95 1.2 15.24 0 12 0A12 12 0 0 0 1.28 6.63l3.99 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}
