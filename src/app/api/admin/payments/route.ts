import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireAdmin } from "@/auth/guards";
import { badRequest, toErrorResponse } from "@/lib/errors";
import { serializeListedPayment } from "@/lib/loan-json";
import { PaymentStatus } from "@/server/types";
import {
  ADMIN_PAYMENT_FILTERS,
  listPaymentsForAdmin,
} from "@/services/payments/payment-list-service";

const ESTADOS_FILTRABLES = new Set<string>(ADMIN_PAYMENT_FILTERS);

/** Solo acepta un estado que la cola sepa filtrar: la URL es entrada de usuario. */
function parseStatusFilter(value: string | null): PaymentStatus | undefined {
  if (value === null) return undefined;
  if (!ESTADOS_FILTRABLES.has(value)) {
    throw badRequest(`Estado desconocido. Usa uno de: ${ADMIN_PAYMENT_FILTERS.join(", ")}`);
  }
  return value as PaymentStatus;
}

/**
 * `GET /api/admin/payments?estado=...&limite=...` (PROJECT_SPEC §11, F10-4): la cola de pagos.
 *
 * Sin `estado` sale `PENDING`, que es lo que hay que resolver. El permiso es de **rol**, no de
 * propiedad: es la diferencia con `/api/payments`, que sí exige que el préstamo sea del titular.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    await requireAdmin({ auth, db, cookies: cookieStore });

    const url = new URL(request.url);
    const status = parseStatusFilter(url.searchParams.get("estado"));

    const limiteRaw = url.searchParams.get("limite");
    let limit: number | undefined;
    if (limiteRaw !== null) {
      limit = Number(limiteRaw);
      if (!Number.isInteger(limit) || limit < 1) {
        throw badRequest("El límite debe ser un entero positivo");
      }
    }

    const pagos = await listPaymentsForAdmin({ db }, { status, limit });

    return Response.json({ payments: pagos.map(serializeListedPayment) });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
