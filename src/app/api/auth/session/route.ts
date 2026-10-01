import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { exchangeSession, readSession } from "@/services/auth/session-endpoint";
import { ensureAppUser } from "@/services/users/ensure-app-user";

export async function POST(request: Request): Promise<Response> {
  const db = getDb();
  const result = await exchangeSession(request, {
    auth: getAuthAdmin(),
    cookies: await cookies(),
    ensureAppUser: (input) => ensureAppUser(db, input),
  });
  return Response.json(result.body, { status: result.status, headers: result.headers });
}

export async function GET(): Promise<Response> {
  const result = await readSession({ auth: getAuthAdmin(), cookies: await cookies() });
  return Response.json(result.body, { status: result.status, headers: result.headers });
}
