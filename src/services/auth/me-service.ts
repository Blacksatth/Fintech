import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { requireUser } from "@/auth/guards";
import { toErrorResponse } from "@/lib/errors";
import { userProfileDocSchema } from "@/server/user-doc";

function cleanProfileData(data: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === "object" && "delete" in v && typeof (v as { delete: unknown }).delete === "function") {
      // Skip FieldValue.delete() sentinels
      continue;
    }
    cleaned[k] = v;
  }
  return cleaned;
}

export interface MeDeps {
  auth: Auth;
  db: Firestore;
  cookies: {
    get(name: string): { name: string; value: string } | undefined;
  };
}

export interface ProfileUpdateInput {
  city?: string;
  occupation?: string;
  monthlyIncomeRange?: string;
}

interface UserDataWithTimestamp {
  email?: string;
  role?: string;
  status?: string;
  fullName?: string;
  phone?: string;
  createdAt?: { toMillis: () => number };
  updatedAt?: { toMillis: () => number };
}

interface ProfileDataWithTimestamp {
  city?: string;
  occupation?: string;
  monthlyIncomeRange?: string;
  updatedAt?: { toMillis: () => number };
}

async function getUserData(db: Firestore, uid: string) {
  const userSnap = await db.collection("users").doc(uid).get();
  const profileSnap = await db.collection("user_profiles").doc(uid).get();

  const userData = userSnap.data() as UserDataWithTimestamp | undefined;
  const profileData = profileSnap.data() ? cleanProfileData(profileSnap.data() as Record<string, unknown>) : {};

  return {
    uid,
    email: userData?.email ?? null,
    role: userData?.role ?? null,
    status: userData?.status ?? null,
    fullName: userData?.fullName ?? null,
    phone: userData?.phone ?? null,
    createdAt: userData?.createdAt?.toMillis?.() ?? null,
    updatedAt: userData?.updatedAt?.toMillis?.() ?? null,
    profile: {
      city: (profileData as ProfileDataWithTimestamp).city ?? null,
      occupation: (profileData as ProfileDataWithTimestamp).occupation ?? null,
      monthlyIncomeRange: (profileData as ProfileDataWithTimestamp).monthlyIncomeRange ?? null,
      updatedAt: (profileData as ProfileDataWithTimestamp).updatedAt?.toMillis?.() ?? null,
    },
  };
}

export async function getMe(deps: MeDeps): Promise<{ status: number; body: unknown }> {
  try {
    const context = await requireUser(deps);
    const data = await getUserData(deps.db, context.uid);
    return { status: 200, body: data };
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return { status, body };
  }
}

export async function patchMeProfile(
  deps: MeDeps,
  input: ProfileUpdateInput,
): Promise<{ status: number; body: unknown }> {
  try {
    const context = await requireUser(deps);

    const allowedFields = ["city", "occupation", "monthlyIncomeRange"];
    const updates: Record<string, unknown> = {};
    const toDelete: string[] = [];

    for (const field of allowedFields) {
      if (field in input && input[field as keyof ProfileUpdateInput] !== undefined) {
        const value = input[field as keyof ProfileUpdateInput];
        if (value === null || value === "") {
          toDelete.push(field);
        } else if (typeof value === "string") {
          updates[field] = value.trim();
        } else {
          updates[field] = value;
        }
      }
    }

    if (Object.keys(updates).length === 0 && toDelete.length === 0) {
      return {
        status: 400,
        body: { error: { code: "VALIDATION", message: "No hay campos válidos para actualizar" } },
      };
    }

    const now = new Date();
    const profileInput: Record<string, unknown> = { ...updates, updatedAt: now };

    const candidate = userProfileDocSchema.parse(profileInput);

    for (const field of toDelete) {
      (candidate as Record<string, unknown>)[field] = FieldValue.delete();
    }

    await deps.db.collection("user_profiles").doc(context.uid).set(candidate, { merge: true });

    const updatedProfileSnap = await deps.db.collection("user_profiles").doc(context.uid).get();
    const profileData = updatedProfileSnap.data() ? cleanProfileData(updatedProfileSnap.data() as Record<string, unknown>) : {};

    return {
      status: 200,
      body: {
        ok: true,
        profile: {
          city: (profileData as ProfileDataWithTimestamp).city ?? null,
          occupation: (profileData as ProfileDataWithTimestamp).occupation ?? null,
          monthlyIncomeRange: (profileData as ProfileDataWithTimestamp).monthlyIncomeRange ?? null,
          updatedAt: (profileData as ProfileDataWithTimestamp).updatedAt?.toMillis?.() ?? null,
        },
      },
    };
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return { status, body };
  }
}