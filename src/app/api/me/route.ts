import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { getMe, patchMeProfile } from "@/services/auth/me-service";

export async function GET(): Promise<Response> {
  const cookieStore = await cookies();
  const db = getDb();
  const auth = getAuthAdmin();

  const result = await getMe({ auth, db, cookies: cookieStore });
  return Response.json(result.body, { status: result.status });
}

export async function PATCH(request: Request): Promise<Response> {
  const cookieStore = await cookies();
  const db = getDb();
  const auth = getAuthAdmin();

  const body = await request.json();
  const result = await patchMeProfile({ auth, db, cookies: cookieStore }, body);
  return Response.json(result.body, { status: result.status });
}