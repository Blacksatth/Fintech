import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { toErrorResponse } from "@/lib/errors";
import { listPublicPaymentChannels } from "@/services/payments/payment-channel-service";

/**
 * `GET /api/payment-channels` (F10-4): los canales por los que el cliente puede pagar.
 *
 * Solo los **activos**, y solo su vista pública. El `meta` sí viaja, pero recortado a una
 * allowlist (`toPublicPaymentChannel`): ahí están la cuenta y el Nequi a los que hay que pagar, que
 * el cliente necesita de verdad, y también el lugar donde un admin podría escribir algo que no
 * debe salir. La proyección decide, no el route handler.
 */
export async function GET(): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    await requireUser({ auth, db, cookies: cookieStore });

    const channels = await listPublicPaymentChannels({ db });

    return Response.json({ channels });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
