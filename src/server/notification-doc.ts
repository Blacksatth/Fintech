import { z } from "zod";
import { NotificationStatus } from "./types";
import { creditDocDateSchema, type CreditDocDate } from "./credit-doc";
import { assertSafeInteger } from "./money";

/**
 * Documentos de notificación (PROJECT_SPEC §8.1 `notifications/{id}` y §16).
 *
 * Dominio puro: sin Firebase ni Next. En el MVP **la bandeja ES la colección** (`in-app`), y el
 * proveedor de email es un esqueleto sin SMTP (§16, decisión D6): no hay credenciales reales que
 * configurar. Lo que sí hay que garantizar aquí es que un aviso no se repita: el doc ID es
 * determinista, así que reavisar la cartera cien veces deja **un** aviso por cuota y estado.
 */

export { NotificationStatus } from "./types";

/**
 * Tipos del MVP. §16 lista los eventos que dispara el dominio; en F11 solo se emiten los dos de
 * cuota (próxima/vencida) y los demás llegan con F15-1, que es quien tiene la bandeja de cliente.
 */
export const NotificationType = {
  INSTALLMENT_DUE_SOON: "INSTALLMENT_DUE_SOON",
  INSTALLMENT_OVERDUE: "INSTALLMENT_OVERDUE",
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const NotificationChannel = {
  IN_APP: "IN_APP",
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

/** Caracteres que Firestore no admite en un doc ID (además de la longitud máxima). */
function sanitizeIdPart(value: string, context: string): string {
  const limpio = value.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!/[A-Za-z0-9]/.test(limpio)) {
    // Ni un solo carácter utilizable: es un dato corrupto, no un id que "salga" raro.
    throw new RangeError(`${context} sin caracteres válidos para un doc ID (recibido ${value})`);
  }
  return limpio;
}

/**
 * Doc ID determinista `${userId}_${type}_${refKey}`.
 *
 * `refKey` es la entidad que **_provoca** el aviso (para F11, `${loanId}_${installmentNumber}`).
 * Es la clave que hace idempotente el envío: la misma cuota en el mismo estado siempre cae en el
 * mismo doc, y reavisar la cartera no genera un segundo aviso para lo mismo.
 */
export function notificationDocId(userId: string, type: NotificationType, refKey: string): string {
  const id = [
    sanitizeIdPart(userId, "userId"),
    sanitizeIdPart(type, "type"),
    sanitizeIdPart(refKey, "refKey"),
  ].join("_");
  if (id.length > 1500) {
    throw new RangeError(`Id de notificación demasiado largo (${id.length}): acorta userId o refKey`);
  }
  return id;
}

export interface NotificationDoc {
  userId: string;
  type: NotificationType;
  channel: NotificationChannel;
  title: string;
  body: string;
  status: NotificationStatus;
  readAt?: CreditDocDate;
  sentAt?: CreditDocDate;
  error?: string;
  payload: Record<string, unknown>;
  createdAt: CreditDocDate;
  updatedAt: CreditDocDate;
}

export interface BuildNotificationInput {
  userId: string;
  type: NotificationType;
  channel?: NotificationChannel;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
}

export const notificationDocSchema = z
  .object({
    userId: z.string().trim().min(1),
    type: z.enum([NotificationType.INSTALLMENT_DUE_SOON, NotificationType.INSTALLMENT_OVERDUE]),
    channel: z.enum([NotificationChannel.IN_APP]),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(1000),
    status: z.enum([
      NotificationStatus.PENDING,
      NotificationStatus.SENT,
      NotificationStatus.READ,
      NotificationStatus.FAILED,
    ]),
    readAt: creditDocDateSchema.optional(),
    sentAt: creditDocDateSchema.optional(),
    error: z.string().trim().min(1).max(500).optional(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: creditDocDateSchema,
    updatedAt: creditDocDateSchema,
  })
  .strict()
  .refine((doc) => doc.status !== NotificationStatus.SENT || doc.sentAt !== undefined, {
    message: "Una notificación SENT sin sentAt no se puede ordenar en la bandeja",
    path: ["sentAt"],
  });

export function buildNotificationDoc(input: BuildNotificationInput, now: Date): NotificationDoc {
  const candidate: NotificationDoc = {
    userId: input.userId,
    type: input.type,
    channel: input.channel ?? NotificationChannel.IN_APP,
    title: input.title,
    body: input.body,
    status: NotificationStatus.SENT,
    sentAt: now,
    payload: input.payload ?? {},
    createdAt: now,
    updatedAt: now,
  };
  return notificationDocSchema.parse(candidate) as NotificationDoc;
}

/** Cuántos días lleva impaga la cuota que va a recibir el aviso. */
export function installmentReminderRefKey(loanId: string, installmentNumber: number): string {
  assertSafeInteger(installmentNumber, "installmentNumber");
  if (installmentNumber < 1) {
    throw new RangeError("installmentNumber debe ser >= 1");
  }
  return `${loanId}_${installmentNumber}`;
}
