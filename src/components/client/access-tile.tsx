import { Card, CardContent } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/link-button";

export interface AccessTileProps {
  href: string;
  title: string;
  description: string;
  cta: string;
}

/** Los accesos del dashboard: una tarjeta con su enlace, idéntica en forma a las del hub. */
export function AccessTile({ href, title, description, cta }: AccessTileProps) {
  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col items-start gap-2">
        <h3 className="font-semibold text-ink">{title}</h3>
        <p className="flex-1 text-sm text-ink-muted">{description}</p>
        <LinkButton href={href} variant="secondary" size="sm" className="mt-3">
          {cta}
        </LinkButton>
      </CardContent>
    </Card>
  );
}