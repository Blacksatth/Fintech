"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export interface NavItem {
  href: string;
  label: string;
}

/**
 * Enlaces de la cabecera con el estado activo marcado (guideline UX: la página actual debe
 * distinguirse visualmente). No todos los enlaces del layout están activos alguna vez: se marca
 * con `aria-current="page"` y el color primario, sin cambiar el layout.
 *
 * Vive aparte porque `usePathname` exige un Client Component; la cabecera sigue siendo servidor.
 */
export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname() ?? "/";

  return (
    <>
      {items.map((item) => {
        const activo =
          item.href === "/"
            ? pathname === "/"
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={activo ? "page" : undefined}
            className={cn(
              "font-medium transition-colors",
              activo ? "text-primary-700" : "text-ink-muted hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}