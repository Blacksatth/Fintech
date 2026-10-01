import { forbidden } from "./errors";

export interface OriginCheck {
  host: string | null;
  protocol: string | null;
}

export function isSameOrigin(
  origin: string | null | undefined,
  expected: OriginCheck,
): boolean {
  if (!origin) return true;
  if (!expected.host) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.host !== expected.host) return false;
  if (expected.protocol && parsed.protocol !== expected.protocol) return false;
  return true;
}

export function originCheckFrom(request: Request): OriginCheck {
  let protocol: string | null = null;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedProto) {
    protocol = `${forwardedProto.toLowerCase()}:`;
  } else {
    try {
      protocol = new URL(request.url).protocol;
    } catch {
      protocol = null;
    }
  }
  return { host: request.headers.get("host"), protocol };
}

export function assertSameOrigin(request: Request): void {
  if (!isSameOrigin(request.headers.get("origin"), originCheckFrom(request))) {
    throw forbidden("Origen de la solicitud no permitido");
  }
}
