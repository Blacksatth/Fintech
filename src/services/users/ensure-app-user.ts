import { type Firestore } from "firebase-admin/firestore";
import { buildUserDoc, buildUserProfileDoc, type UserDoc, type UserProfileDoc } from "../../server/user-doc";

/**
 * Alta o vinculación del usuario de la aplicación (F4-2).
 *
 * Ocurre al intercambiar el ID token por la cookie de sesión: el uid ya está
 * verificado por Firebase, así que `users/{uid}` y `user_profiles/{uid}` quedan
 * creados en el mismo paso. Es **idempotente y no destructivo**: si el documento
 * ya existe (p. ej. el admin del seed o un login posterior) no se pisa, porque
 * ahí puede haber rol, estado o perfil editado.
 *
 * `users/{uid}` exige nombre y teléfono (PROJECT_SPEC §8.1), datos que Google no
 * entrega: sin ellos el resultado es `profileComplete: false` y el cliente pide
 * el dato faltante. Nunca se escribe un documento a medias.
 */

export interface AppUserIdentity {
  email: string;
  emailVerified: boolean;
}

export interface AppUserProfileInput {
  fullName?: string;
  phone?: string;
}

export interface PlanAppUserInput {
  identity: AppUserIdentity;
  profile: AppUserProfileInput;
  userExists: boolean;
  now: Date;
}

export interface PlanAppUserResult {
  create: boolean;
  profileComplete: boolean;
  userDoc: UserDoc | undefined;
  profileDoc: UserProfileDoc | undefined;
}

export interface EnsureAppUserInput {
  uid: string;
  identity: AppUserIdentity;
  profile: AppUserProfileInput;
  now?: Date;
}

export interface EnsureAppUserResult {
  created: boolean;
  profileComplete: boolean;
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Decisión pura: qué documentos hay que escribir. Sin Firebase, testeable sola. */
export function planAppUser(input: PlanAppUserInput): PlanAppUserResult {
  if (input.userExists) {
    return { create: false, profileComplete: true, userDoc: undefined, profileDoc: undefined };
  }

  if (!hasText(input.profile.fullName) || !hasText(input.profile.phone)) {
    return { create: false, profileComplete: false, userDoc: undefined, profileDoc: undefined };
  }

  const now = input.now;
  return {
    create: true,
    profileComplete: true,
    userDoc: buildUserDoc(
      {
        email: input.identity.email,
        fullName: input.profile.fullName as string,
        phone: input.profile.phone as string,
      },
      now,
    ),
    profileDoc: buildUserProfileDoc({}, now),
  };
}

export async function ensureAppUser(
  db: Firestore,
  input: EnsureAppUserInput,
): Promise<EnsureAppUserResult> {
  const now = input.now ?? new Date();
  const userRef = db.collection("users").doc(input.uid);
  const userSnap = await userRef.get();
  const plan = planAppUser({ identity: input.identity, profile: input.profile, userExists: userSnap.exists, now });

  if (plan.create && plan.userDoc && plan.profileDoc) {
    await userRef.set(plan.userDoc);
    await db.collection("user_profiles").doc(input.uid).set(plan.profileDoc);
  }

  return { created: plan.create, profileComplete: plan.profileComplete };
}
