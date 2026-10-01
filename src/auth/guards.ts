import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { unauthorized, forbidden } from "@/lib/errors";
import { verifySessionCookieForRequest } from "@/server/auth-session";
import { type UserDoc } from "@/server/user-doc";

export interface AuthContext {
  uid: string;
  email: string | null;
  role: string;
  status: string;
}

export interface GuardDeps {
  auth: Auth;
  db: Firestore;
  cookies: {
    get(name: string): { name: string; value: string } | undefined;
  };
}

async function getUserDoc(db: Firestore, uid: string): Promise<UserDoc | null> {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return null;
  return snap.data() as UserDoc;
}

export async function requireUser(deps: GuardDeps): Promise<AuthContext> {
  const cookie = deps.cookies.get("__session")?.value;
  const session = await verifySessionCookieForRequest(deps.auth, cookie);
  if (!session) {
    throw unauthorized("Sesión no válida");
  }

  const userDoc = await getUserDoc(deps.db, session.uid);
  if (!userDoc) {
    throw unauthorized("Usuario no encontrado");
  }

  return {
    uid: session.uid,
    email: session.email,
    role: userDoc.role,
    status: userDoc.status,
  };
}

export async function requireRole(
  deps: GuardDeps,
  allowedRoles: string[],
): Promise<AuthContext> {
  const context = await requireUser(deps);

  if (!allowedRoles.includes(context.role)) {
    throw forbidden("No tienes permiso para realizar esta acción");
  }

  if (context.status !== "ACTIVE") {
    throw forbidden("Tu cuenta está suspendida");
  }

  return context;
}

export async function requireAdmin(deps: GuardDeps): Promise<AuthContext> {
  return requireRole(deps, ["ADMIN"]);
}

export function assertOwnership(context: AuthContext, resourceUid: string): void {
  if (context.uid !== resourceUid) {
    throw forbidden("No tienes acceso a este recurso");
  }
}