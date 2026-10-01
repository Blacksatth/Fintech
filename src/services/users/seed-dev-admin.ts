import { type Auth } from "firebase-admin/auth";
import { type Firestore } from "firebase-admin/firestore";
import { Role } from "../../server/types";
import {
  assertSeedPasswordIsStrong,
  buildUserDoc,
  buildUserProfileDoc,
} from "../../server/user-doc";

/**
 * Datos de arranque del administrador de DESARROLLO (F4-1).
 *
 * Idempotente: si el usuario de Auth ya existe se reutiliza su uid y los
 * documentos se dejan intactos (no se pisan datos de negocio). El script de
 * seed decide con `--force` si rectify el perfil; el servicio por sí solo
 * nunca destruye información.
 *
 * `db` y `auth` se inyectan: el servicio es testeable contra Firestore real
 * y el script decide cómo inicializa el Admin SDK.
 */

export interface SeedDevAdminInput {
  email: string;
  password: string;
  fullName: string;
  phone: string;
}

export interface SeedDevAdminResult {
  uid: string;
  createdInAuth: boolean;
  createdInFirestore: boolean;
}

export async function seedDevAdmin(
  db: Firestore,
  auth: Auth,
  input: SeedDevAdminInput,
): Promise<SeedDevAdminResult> {
  assertSeedPasswordIsStrong(input.password);

  const email = input.email.trim().toLowerCase();

  const now = new Date();
  const userDoc = buildUserDoc(
    { email, fullName: input.fullName, phone: input.phone, role: Role.ADMIN },
    now,
  );
  const profileDoc = buildUserProfileDoc({}, now);

  const existingAuthUser = await auth.getUserByEmail(email).catch(() => null);
  if (existingAuthUser) {
    await auth.updateUser(existingAuthUser.uid, { password: input.password });
  }
  const createdInAuth = existingAuthUser === null;
  const uid = existingAuthUser
    ? existingAuthUser.uid
    : (
        await auth.createUser({
          email,
          password: input.password,
          emailVerified: false,
          disabled: false,
        })
      ).uid;

  const userRef = db.collection("users").doc(uid);
  const profileRef = db.collection("user_profiles").doc(uid);
  const [userSnap, profileSnap] = await Promise.all([userRef.get(), profileRef.get()]);
  const createdInFirestore = !userSnap.exists && !profileSnap.exists;

  if (createdInFirestore) {
    await userRef.set(userDoc);
    await profileRef.set(profileDoc);
  }

  return { uid, createdInAuth, createdInFirestore };
}
