import { AppHeader } from "@/components/layout/app-header";
import { NotFoundView } from "@/components/layout/not-found-view";

/**
 * 404 global (URL que no existe). La cabecera va aquí porque la raíz no tiene layout propio.
 *
 * Los grupos con layout (`(dashboard)`, `admin`) necesitan su propio `not-found.tsx`: un
 * `notFound()` lanzado dentro de ellos renderiza la 404 **de su segmento**, y si no existe el
 * resultado es una página con cabecera y cuerpo vacío.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <AppHeader />
      <NotFoundView />
    </div>
  );
}
