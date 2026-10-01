import { z } from "zod";
import { ActorType, Currency, PaymentStatus } from "./types";
import { assertSafeInteger } from "./money";
import { creditDocDateSchema, loanInstallmentDocId, type CreditDocDate } from "./credit-doc";

/**
 * Documentos de pagos (PROJECT_SPEC §8.1 y §11).
 *
 * Dominio puro: sin imports de Next/Firebase, para que los builders sean testeables sin
 * infraestructura. La máquina de estados (PENDING → CONFIRMED | REJECTED, CONFIRMED → REVERSED)
 * vive en `src/server/payments.ts` (F10-2); aquí solo la forma del documento y sus invariantes.
 *
 * **Un comprobante nunca paga.** Este archivo no conoce Cloudinary ni subidas: `receiptUrl` es un
 * dato opcional y la confirmación es siempre humana (F10-2).
 */

export { ActorType, Currency, PaymentStatus } from "./types";
export type { CreditDocDate } from "./credit-doc";

/**
 * Tipos de canal del MVP. Son **texto estático configurable**, no integraciones: no hay API de
 * Neqi, ni del Bancolombia, ni de Bre-B. El doc ID de `payment_channels` es el propio tipo, así
 * que un canal es único por tipo y los datos de la cuenta (banco, número, titular) viven en
 * `meta`, que es lo que un admin edita cuando hay datos reales.
 */
export const PaymentChannelType = {
  BANK_TRANSFER: "BANK_TRANSFER",
  NEQUI: "NEQUI",
  QR: "QR",
  BREB: "BREB",
} as const;
export type PaymentChannelType = (typeof PaymentChannelType)[keyof typeof PaymentChannelType];

/**
 * Claves de `meta` que el cliente **necesita ver** para pagar: la cuenta a la que hay que
 * transferir, el número Nequi, la cláusula de Diálogo Activo y el QR.
 *
 * Viven en el dominio y no en el servicio porque las consume **quien escribe** (la pantalla de
 * configuración, que solo puede editar estas claves) y **quien lee** (la proyección pública). Si
 * vivieran en un solo lado, el otro dejaría de filtrar o dejaría de poder editar.
 */
export const PAYMENT_CHANNEL_PUBLIC_META_KEYS = [
  "bankName",
  "accountType",
  "accountNumber",
  "accountHolder",
  "nequiNumber",
  "clauseDialogoActivo",
  "qrImageUrl",
] as const;

export type PaymentChannelPublicMetaKey = (typeof PAYMENT_CHANNEL_PUBLIC_META_KEYS)[number];

export function isPublicPaymentChannelMetaKey(value: string): value is PaymentChannelPublicMetaKey {
  return (PAYMENT_CHANNEL_PUBLIC_META_KEYS as readonly string[]).includes(value);
}

/**
 * Marca que separa "este canal tiene datos inventados" de "alguien ya puso los datos reales pero
 * nadie los ha revisado". El segundo estado **no** es una aprobación legal: el MVP no tiene quién
 * la firme, y dejar que un admin se auto-declare "esto ya es legal" con un clic sería fabricar una
 * verdad que el sistema no puede sostener. Por eso el texto de la opción lo dice literalmente.
 */
export const PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO = "PENDING_LEGAL_REVIEW";
export const PAYMENT_CHANNEL_LEGAL_REVIEW_REPLACED = "DEMO_REPLACED_PENDING_LEGAL_REVIEW";

/** Clave con la que el seed marca los datos ficticios. */
export const PAYMENT_CHANNEL_DEMO_META_KEY = "demo";

/** ==================== payment_channels ==================== */

export interface PaymentChannelDoc {
  name: string;
  type: PaymentChannelType;
  /** Texto que el cliente lee antes de pagar. Configurable, sin llamadas a ninguna API. */
  instructionsText: string;
  meta: Record<string, unknown>;
  isActive: boolean;
  createdAt: CreditDocDate;
  updatedAt: CreditDocDate;
}

export interface BuildPaymentChannelInput {
  name: string;
  type: PaymentChannelType;
  instructionsText: string;
  meta?: Record<string, unknown>;
  isActive?: boolean;
}

/**
 * `createdAt`/`updatedAt` no aparecen en la línea de §8.1 para `payment_channels`, pero sí en el
 * esquema real de las demás collections de configuración (`credit_products`, `risk_rules`,
 * `interest_rates`): sin ellos no se puede saber cuándo un admin cambió unas instrucciones de pago.
 */
export const paymentChannelDocSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    type: z.enum([
      PaymentChannelType.BANK_TRANSFER,
      PaymentChannelType.NEQUI,
      PaymentChannelType.QR,
      PaymentChannelType.BREB,
    ]),
    instructionsText: z.string().trim().min(10).max(2000),
    meta: z.record(z.string(), z.unknown()),
    isActive: z.boolean().default(true),
    createdAt: creditDocDateSchema,
    updatedAt: creditDocDateSchema,
  })
  .strict();

export function buildPaymentChannelDoc(input: BuildPaymentChannelInput, now: Date): PaymentChannelDoc {
  const candidate: PaymentChannelDoc = {
    name: input.name,
    type: input.type,
    instructionsText: input.instructionsText,
    meta: input.meta ?? {},
    isActive: input.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };
  return paymentChannelDocSchema.parse(candidate) as PaymentChannelDoc;
}

/** ==================== payments ==================== */

/**
 * Un pago **nace** `PENDING` y no tiene más estados aquí: `buildPaymentDoc` no acepta un estado
 * terminal, porque un `CONFIRMED` solo puede existir si una persona lo confirmó (F10-2).
 */
export interface PaymentDoc {
  paymentNumber: string;
  userId: string;
  loanId: string;
  installmentId: string;
  amountPesos: number;
  currency: Currency;
  /** ID de `payment_channels`: el canal por el que el cliente dice haber pagado. */
  channel: string;
  reference?: string;
  adminNote?: string;
  status: PaymentStatus;
  receiptUrl?: string;
  /** `Idempotency-Key` de la creación. La de confirmar/rechazar no se guarda aquí (ver `disbursementDocSchema`). */
  idempotencyKey: string;
  confirmedBy?: string;
  confirmedAt?: CreditDocDate;
  rejectedBy?: string;
  rejectedAt?: CreditDocDate;
  reason?: string;
  createdAt: CreditDocDate;
  updatedAt: CreditDocDate;
}

export interface BuildPaymentInput {
  paymentNumber: string;
  userId: string;
  loanId: string;
  installmentId: string;
  amountPesos: number;
  currency: Currency;
  channel: string;
  idempotencyKey: string;
  reference?: string;
  receiptUrl?: string;
}

/**
 * El pago apunta a una cuota de **su propio** préstamo: `installmentId` es el doc ID determinista
 * `${loanId}_${n}` de `loan_installments`. Sin esta comprobación, un pago podría apuntar a la cuota
 * de otro préstamo y el saldo que se recalcula al confirmarlo sería el equivocado.
 */
function assertInstallmentBelongsToLoan(loanId: string, installmentId: string): void {
  const prefix = `${loanId}_`;
  if (!installmentId.startsWith(prefix)) {
    throw new RangeError(`installmentId ${installmentId} no pertenece al préstamo ${loanId}`);
  }
  const number = Number.parseInt(installmentId.slice(prefix.length), 10);
  if (!/^\d+$/.test(installmentId.slice(prefix.length)) || loanInstallmentDocId(loanId, number) !== installmentId) {
    throw new RangeError(`installmentId ${installmentId} no tiene la forma ${loanId}_{n}`);
  }
}

/**
 * §8.1 escribe `created/updated` para `payments`, pero el índice compuesto que la propia spec
 * declara es `status+createdAt` (§8.2): el campo se llama `createdAt`, como en el resto de
 * colecciones.
 */
export const paymentDocSchema = z
  .object({
    paymentNumber: z.string().trim().min(1).max(50),
    userId: z.string().trim().min(1),
    loanId: z.string().trim().min(1),
    installmentId: z.string().trim().min(1),
    amountPesos: z.number().int().positive(),
    currency: z.enum([Currency.COP]),
    channel: z.string().trim().min(1).max(50),
    reference: z.string().trim().min(1).max(120).optional(),
    adminNote: z.string().trim().max(500).optional(),
    status: z.enum([
      PaymentStatus.PENDING,
      PaymentStatus.CONFIRMED,
      PaymentStatus.REJECTED,
      PaymentStatus.REVERSED,
    ]),
    receiptUrl: z.string().trim().min(1).max(2048).optional(),
    idempotencyKey: z.string().trim().min(1),
    confirmedBy: z.string().trim().min(1).optional(),
    confirmedAt: creditDocDateSchema.optional(),
    rejectedBy: z.string().trim().min(1).optional(),
    rejectedAt: creditDocDateSchema.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
    createdAt: creditDocDateSchema,
    updatedAt: creditDocDateSchema,
  })
  .strict()
  .refine((doc) => doc.confirmedBy === undefined || doc.confirmedAt !== undefined, {
    message: "confirmedBy sin confirmedAt: no se puede saber cuándo se confirmó",
    path: ["confirmedAt"],
  })
  .refine((doc) => doc.rejectedBy === undefined || doc.rejectedAt !== undefined, {
    message: "rejectedBy sin rejectedAt: no se puede saber cuándo se rechazó",
    path: ["rejectedAt"],
  });

export function buildPaymentDoc(input: BuildPaymentInput, now: Date): PaymentDoc {
  assertSafeInteger(input.amountPesos, "amountPesos");
  assertInstallmentBelongsToLoan(input.loanId, input.installmentId);
  const candidate: PaymentDoc = {
    paymentNumber: input.paymentNumber,
    userId: input.userId,
    loanId: input.loanId,
    installmentId: input.installmentId,
    amountPesos: input.amountPesos,
    currency: input.currency,
    channel: input.channel,
    reference: input.reference,
    status: PaymentStatus.PENDING,
    receiptUrl: input.receiptUrl,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
  return paymentDocSchema.parse(candidate) as PaymentDoc;
}

/** ==================== payment_events ==================== */

/**
 * Doc ID determinista `${paymentId}_{n}`.
 *
 * El historial se lee con `getAll` de ids construidos, no con `where(paymentId) + orderBy`: §8.2 no
 * declara índice para `payment_events` y desplegar uno exige `roles/datastore.owner` (trampa
 * conocida de F9-2). El `n` se reserva dentro de la transacción que escribe el evento, leyendo los
 * eventos del pago dentro de esa misma transacción.
 */
export function paymentEventDocId(paymentId: string, sequence: number): string {
  assertSafeInteger(sequence, "sequence");
  if (sequence < 1) {
    throw new RangeError("sequence debe ser >= 1");
  }
  return `${paymentId}_${sequence}`;
}

export interface PaymentEventDoc {
  paymentId: string;
  fromStatus: PaymentStatus;
  toStatus: PaymentStatus;
  actorType: ActorType;
  actorId?: string;
  reason?: string;
  metadata: Record<string, unknown>;
  createdAt: CreditDocDate;
}

export interface BuildPaymentEventInput {
  paymentId: string;
  fromStatus: PaymentStatus;
  toStatus: PaymentStatus;
  actorType: ActorType;
  actorId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export const paymentEventDocSchema = z
  .object({
    paymentId: z.string().trim().min(1),
    fromStatus: z.enum([
      PaymentStatus.PENDING,
      PaymentStatus.CONFIRMED,
      PaymentStatus.REJECTED,
      PaymentStatus.REVERSED,
    ]),
    toStatus: z.enum([
      PaymentStatus.PENDING,
      PaymentStatus.CONFIRMED,
      PaymentStatus.REJECTED,
      PaymentStatus.REVERSED,
    ]),
    actorType: z.enum([ActorType.SYSTEM, ActorType.USER, ActorType.ADMIN]),
    actorId: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: creditDocDateSchema,
  })
  .strict();

export function buildPaymentEventDoc(input: BuildPaymentEventInput, now: Date): PaymentEventDoc {
  const candidate: PaymentEventDoc = {
    paymentId: input.paymentId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    actorType: input.actorType,
    actorId: input.actorId,
    reason: input.reason,
    metadata: input.metadata ?? {},
    createdAt: now,
  };
  return paymentEventDocSchema.parse(candidate) as PaymentEventDoc;
}
