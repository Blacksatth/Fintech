import Link from "next/link";
import { LinkButton } from "@/components/ui";

/**
 * Cuerpo de la página 404, sin cabecera: cada segmento que la renderiza ya tiene la suya (el
 * layout del grupo), y la raíz sí la pone alrededor.
 */
export function NotFoundView() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-start gap-4 px-4 py-16">
      <p className="text-sm font-semibold uppercase tracking-wide text-primary-700">Error 404</p>
      <h1 className="text-3xl font-bold tracking-tight text-ink">No encontramos esta página</h1>
      <p className="max-w-xl text-ink-muted">
        Puede que el enlace esté mal escrito o que el recurso ya no exista. Desde el inicio llegas a
        todo lo que tienes disponible.
      </p>
      <div className="flex flex-wrap gap-3">
        <LinkButton href="/">Ir al inicio</LinkButton>
        <LinkButton href="/mis-prestamos" variant="secondary">
          Mis préstamos
        </LinkButton>
      </div>
      <p className="text-sm text-ink-muted">
        ¿Necesitas crear una cuenta?{" "}
        <Link href="/registro" className="text-primary-700 underline underline-offset-2">
          Regístrate
        </Link>
        .
      </p>
    </main>
  );
}
