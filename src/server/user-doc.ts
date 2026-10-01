import { z } from "zod";
import { Role, UserStatus } from "./types";

/**
 * Documentos `users/{uid}` y `user_profiles/{uid}` (PROJECT_SPEC §8.1).
 *
 * Dominio puro: este módulo NO importa Next ni Firebase, solo describe y valida
 * la forma de los documentos. La contraseña nunca vive en Firestore (está en
 * Firebase Auth); el schema es estricto para que no se guarden campos extra
 * (minimización de datos, §7.3/§14).
 */

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email("email inválido");

const phone = z
  .string()
  .trim()
  .min(7, "teléfono demasiado corto")
  .max(20)
  .regex(/^\+?[0-9]{7,20}$/, "teléfono solo admite dígitos y un + inicial");

/** Bandas de ingreso mensual en COP. Texto cerrado: nunca se guarda un rango libre. */
export const MonthlyIncomeRange = {
  "0-1M": "0-1M",
  "1M-2M": "1M-2M",
  "2M-4M": "2M-4M",
  "4M-8M": "4M-8M",
  "8M+": "8M+",
} as const;
export type MonthlyIncomeRange = (typeof MonthlyIncomeRange)[keyof typeof MonthlyIncomeRange];

/**
 * `Date` en el dominio; `Timestamp` de Firestore al leer. Los servicios
 * convierten (Admin SDK escribe `Timestamp`, la API responde ISO).
 */
export type UserDocDate = Date | { toMillis: () => number };

export interface UserDoc {
  email: string;
  fullName: string;
  phone: string;
  role: Role;
  status: UserStatus;
  createdAt: UserDocDate;
  updatedAt: UserDocDate;
}

export interface UserProfileDoc {
  city?: string;
  occupation?: string;
  monthlyIncomeRange?: MonthlyIncomeRange;
  updatedAt: UserDocDate;
}

export interface BuildUserDocInput {
  email: string;
  fullName: string;
  phone: string;
  role?: Role;
  status?: UserStatus;
}

export interface BuildUserProfileInput {
  city?: string;
  occupation?: string;
  /** Texto no confiable: la banda se valida en `userProfileDocSchema`. */
  monthlyIncomeRange?: string;
}

const fullName = z.string().trim().min(2, "nombre demasiado corto").max(120);
const city = z.string().trim().min(2).max(80);
const occupation = z.string().trim().min(2).max(120);

const date = z.union([
  z.date(),
  z.custom<UserDocDate>((v) => typeof (v as { toMillis?: unknown }).toMillis === "function"),
]);

export const userDocSchema = z
  .object({
    email,
    fullName,
    phone,
    role: z.enum([Role.CUSTOMER, Role.ADMIN]),
    status: z.enum([UserStatus.ACTIVE, UserStatus.SUSPENDED]),
    createdAt: date,
    updatedAt: date,
  })
  .strict();

export const userProfileDocSchema = z
  .object({
    city: city.optional(),
    occupation: occupation.optional(),
    monthlyIncomeRange: z
      .enum([MonthlyIncomeRange["0-1M"], MonthlyIncomeRange["1M-2M"], MonthlyIncomeRange["2M-4M"], MonthlyIncomeRange["4M-8M"], MonthlyIncomeRange["8M+"]])
      .optional(),
    updatedAt: date,
  })
  .strict();

export function buildUserDoc(input: BuildUserDocInput, now: Date): UserDoc {
  const candidate: UserDoc = {
    email: input.email,
    fullName: input.fullName,
    phone: input.phone,
    role: input.role ?? Role.CUSTOMER,
    status: input.status ?? UserStatus.ACTIVE,
    createdAt: now,
    updatedAt: now,
  };
  return userDocSchema.parse(candidate) as UserDoc;
}

export function buildUserProfileDoc(input: BuildUserProfileInput, now: Date): UserProfileDoc {
  const candidate: Record<string, unknown> = { updatedAt: now };
  const cityValue = input.city?.trim();
  if (cityValue) candidate.city = cityValue;
  const occupationValue = input.occupation?.trim();
  if (occupationValue) candidate.occupation = occupationValue;
  const rangeValue = input.monthlyIncomeRange?.trim();
  if (rangeValue) candidate.monthlyIncomeRange = rangeValue;
  return userProfileDocSchema.parse(candidate) as UserProfileDoc;
}

/** Fuente de verdad del RBAC: rol ADMIN y usuario activo. Ninguna decisión de UI. */
export function isAdminUser(user: Pick<UserDoc, "role" | "status">): boolean {
  return user.role === Role.ADMIN && user.status === UserStatus.ACTIVE;
}

export const SEED_PASSWORD_MIN_LENGTH = 12;

/**
 * Política de la contraseña del admin de desarrollo: nunca en código, llega por
 * `.env` y debe ser larga. Fallar rápido evita un admin débil por descuido.
 */
export function assertSeedPasswordIsStrong(password: string): void {
  if (password.trim().length === 0) {
    throw new Error("SEED_ADMIN_PASSWORD vacía: define una contraseña de desarrollo en .env");
  }
  if (password.length < SEED_PASSWORD_MIN_LENGTH) {
    throw new Error(
      `SEED_ADMIN_PASSWORD demasiado corta: mínimo ${SEED_PASSWORD_MIN_LENGTH} caracteres`,
    );
  }
}
