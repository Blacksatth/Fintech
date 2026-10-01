import { cookies } from "next/headers";
import { z } from "zod";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireRole, requireUser } from "@/auth/guards";
import { Role } from "@/server/types";
import { toErrorResponse, tooManyRequests } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/origin";
import { buildKey, checkRateLimit } from "@/lib/rate-limit";
import { createPayment } from "@/services/payments/payment-service";
import { listPaymentsForLoan } from "@/services/payments/payment-list-service";
import { serializeListedPayment } from "@/lib/loan-json";
import { badRequest } from "@/lib/errors";

/**
 * Registro de pago (PROJECT_SPEC §9, F10-2a).
 *
 * **No hay campo `amountPesos`.** El importe es el saldo de la cuota y lo calcula el servidor
 * dentro de la transacción que crea el pago, así que un monto manipulado no se ignora: es un
 * 400, porque el body no admite campos extra (`strict`).
 */
const createPaymentBody = z
  .object({
    loanId: z.string().trim().min(1).max(128),
    installmentId: z.string().trim().min(1).max(160),
    /** ID de `payment_channels` (su `type`), tal como lo devuelve la lista de canales. */
    channel: z.string().trim().min(1).max(50),
    reference: z.string().trim().max(120).optional(),
  })
  .strict();

/**
 * Límite por cliente y hora. El registro de pago escribe en Firestore, así que un bucle
 * automático llenaría la colección de pagos `PENDING` (y la de auditoría). En memoria y por
 * instancia: es la limitación ya asumida en PROJECT_SPEC §15, no una garantía global.
 */
const CREATE_LIMIT = 20;
const CREATE_WINDOW_MS = 60 * 60 * 1000;

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);

    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    // `requireRole` y no `requireUser`: además del rol, exige cuenta `ACTIVE`. Un ADMIN tampoco
    // puede registrar pagos desde aquí — el pago lo declara quien paga (§9).
    const context = await requireRole({ auth, db, cookies: cookieStore }, [Role.CUSTOMER]);

    const limite = checkRateLimit(buildKey("payments.create", context.uid), CREATE_LIMIT, CREATE_WINDOW_MS);
    if (!limite.allowed) {
      const { status, body } = toErrorResponse(
        tooManyRequests("Demasiados registros de pago. Intenta de nuevo más tarde"),
      );
      const retryAfter = Math.max(1, Math.ceil((limite.resetAt.getTime() - Date.now()) / 1000));
      return Response.json(body, { status, headers: { "Retry-After": String(retryAfter) } });
    }

    const body = createPaymentBody.parse(await request.json());
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";

    const result = await createPayment(
      { db },
      {
        loanId: body.loanId,
        installmentId: body.installmentId,
        channel: body.channel,
        reference: body.reference,
        actor: { uid: context.uid, role: context.role },
        idempotencyKey,
      },
    );

    // 201 la primera vez, 200 en el replay: la respuesta es la misma, el código dice si el pago
    // es nuevo o ya existía.
    return Response.json({ payment: result }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}

/** `?loanId` es obligatorio: sin él no hay un historial definido que devolver. */
const listQuery = z.object({
  loanId: z.string().trim().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * `GET /api/payments?loanId=...` (PROJECT_SPEC §9, F10-4): historial de pagos del préstamo del
 * titular.
 *
 * Solo el historial de un préstamo (`§9 owner`). La cola del admin es otra cosa —permiso por rol,
 * filtro por estado y acciones— y por eso tiene su propia ruta en `/api/admin/payments`: mezclarlas
 * en un solo endpoint obligaría a cada endpoint a conocer la forma del otro. Por eso un ADMIN que
 * llega aquí sin `loanId` recibe un 400 que dice dónde está la cola, en vez de una lista que no
 * puede resolver.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    const context = await requireUser({ auth, db, cookies: cookieStore });
    const url = new URL(request.url);

    if (context.role === Role.ADMIN) {
      throw badRequest("Usa /api/admin/payments para la cola de pagos");
    }

    const query = listQuery.parse({
      loanId: url.searchParams.get("loanId"),
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const pagos = await listPaymentsForLoan({ db }, { loanId: query.loanId, userId: context.uid });

    return Response.json({ payments: pagos.map(serializeListedPayment) });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
