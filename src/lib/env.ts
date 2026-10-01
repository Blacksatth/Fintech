import { z } from "zod";

/**
 * Una variable opcional **vacía** es lo mismo que no declarada.
 *
 * En un `.env` real, `CLOUDINARY_API_KEY=` con la línea en blanco es la forma normal de dejar la
 * variable "pendiente de completar", y con `z.string().min(1).optional()` eso se lee como un
 * entorno inválido y tumba el proceso entero. Aquí la línea en blanco se convierte en `undefined`
 * y la decisión de qué hacer sin esa variable la toma el código que la usa.
 */
const opcional = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const serverEnvSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1, "FIREBASE_PROJECT_ID es obligatoria"),
  GOOGLE_APPLICATION_CREDENTIALS: opcional,
  CLOUDINARY_CLOUD_NAME: opcional,
  CLOUDINARY_API_KEY: opcional,
  CLOUDINARY_API_SECRET: opcional,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Entorno invalido: ${issues}`);
  }
  return parsed.data;
}

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (!cached) {
    cached = parseEnv(process.env);
  }
  return cached;
}