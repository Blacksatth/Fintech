/**
 * Une clases Tailwind sin dependencias (filter(Boolean) + join). No hace merge de conflictos:
 * las primitivas de `ui/` ya resuelven variantes/estados con valores completos y tokens.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
