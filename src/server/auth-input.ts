import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 4096;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOMBIA_PHONE_PATTERN = /^\+57[0-9]{10}$/;
const DIGIT_PATTERN = /[0-9]/;
const SPECIAL_CHARACTER_PATTERN = /[^A-Za-z0-9]/;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => EMAIL_PATTERN.test(value), "correo no válido");

const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `la contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`)
  .max(PASSWORD_MAX_LENGTH, "la contraseña es demasiado larga")
  .refine((value) => DIGIT_PATTERN.test(value), "la contraseña debe incluir al menos un número")
  .refine(
    (value) => SPECIAL_CHARACTER_PATTERN.test(value),
    "la contraseña debe incluir al menos un carácter especial (!@#$...)",
  );

export const PASSWORD_RULE_TEXT = `Mínimo ${PASSWORD_MIN_LENGTH} caracteres, con un número y un carácter especial`;

const fullName = z
  .string()
  .trim()
  .min(3, "escribe tu nombre completo")
  .max(80, "el nombre es demasiado largo");

const phone = z
  .string()
  .trim()
  .regex(COLOMBIA_PHONE_PATTERN, "teléfono colombiano inválido, ej. +573001234567");

export const credentialsSchema = z.object({ email, password }).strict();

export const profileSchema = z.object({ fullName, phone }).strict();

export const registrationSchema = z.object({ email, password, fullName, phone }).strict();

export const sessionExchangeSchema = z
  .object({
    idToken: z.string().min(1, "falta el idToken").max(4096, "idToken demasiado largo"),
    fullName: fullName.optional(),
    phone: phone.optional(),
  })
  .strict();

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "El correo o la contraseña no coinciden.",
  "auth/wrong-password": "El correo o la contraseña no coinciden.",
  "auth/user-not-found": "El correo o la contraseña no coinciden.",
  "auth/invalid-email": "Ese correo no es válido.",
  "auth/email-already-in-use": "Ya existe una cuenta con ese correo.",
  "auth/weak-password": "La contraseña es demasiado débil.",
  "auth/too-many-requests": "Demasiados intentos. Espera unos minutos e intenta de nuevo.",
  "auth/network-request-failed": "Revisa tu conexión e intenta de nuevo.",
  "auth/operation-not-allowed": "Ese método de acceso no está disponible por ahora.",
  "auth/missing-password": "Escribe tu contraseña.",
  "auth/account-exists-with-different-credential":
    "Ese correo ya tiene una cuenta con contraseña. Ingresa con tu contraseña y vuelve a intentar.",
  "auth/popup-closed-by-user": "Cerraste la ventana de acceso sin completar el paso.",
  "auth/cancelled-popup-request": "Cerraste la ventana de acceso sin completar el paso.",
};

export function authErrorMessage(code: string | null | undefined): string {
  if (code && code in AUTH_ERROR_MESSAGES) {
    return AUTH_ERROR_MESSAGES[code];
  }
  return "No pudimos completar la operación. Intenta de nuevo.";
}
