import { cookies } from "next/headers";
import { getAuthAdmin } from "@/lib/admin";
import { closeSession } from "@/services/auth/session-endpoint";

export async function POST(request: Request): Promise<Response> {
  const result = await closeSession(request, { auth: getAuthAdmin(), cookies: await cookies() });
  return Response.json(result.body, { status: result.status, headers: result.headers });
}
