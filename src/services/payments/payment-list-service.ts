import { type Firestore } from "firebase-admin/firestore";
import { InstallmentStatus, PaymentStatus, type Currency } from "@/server/types";
import type { PaymentDoc } from "@/server/payment-doc";
import { getLoanForUser, listInstallmentsForLoan } from "@/services/credit/loan-service";
import { paymentHasReceipt } from "./receipt-service";

/**
 * Listados de pagos para la UI (F10-4).
 *
 * **Índices**: aquí no se puede usar `where(...)` + `orderBy(...)` sobre un campo distinto, porque
 * eso exige un índice compuesto y desplegarlos está bloqueado (falta `roles/datastore.owner` en el
 * service account; trampa ya medida en F9-2). El patrón es el de `payment-channel-service` y
 * `listLoansForUser`: un solo `where` de campo simple (que sí usa índice automático) y orden en
 * memoria. Ninguna consulta de este archivo necesita un índice compuesto.
 */

export interface PaymentListDeps {
  db: Firestore;
}

export interface PaymentListItem {
  paymentId: string;
  paymentNumber: string;
  amountPesos: number;
  currency: Currency;
  channel: string;
  reference?: string;
  status: PaymentStatus;
  hasReceipt: boolean;
  /** `false` cuando el cliente no adjuntó comprobante: el flujo de pagos no lo exige (§11). */
  createdAt: Date;
  installmentId: string;
  installmentNumber: number;
  /** Estado de la cuota en el momento de la lectura: lo mueve la confirmación, no el registro. */
  installmentStatus: InstallmentStatus;
}

export interface AdminPaymentListItem {
  paymentId: string;
  paymentNumber: string;
  userId: string;
  loanId: string;
  installmentId: string;
  amountPesos: number;
  currency: Currency;
  channel: string;
  reference?: string;
  status: PaymentStatus;
  hasReceipt: boolean;
  createdAt: Date;
  /** Quién resolvió el pago, si ya se resolvió. `null` mientras sigue `PENDING`. */
  resolvedBy?: string;
  reason?: string;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "object" && value !== null && "toMillis" in value) {
    return new Date((value as { toMillis(): number }).toMillis());
  }
  throw new Error("payment-list-service: fecha esperada no reconocida");
}

/** Más reciente primero, con desempate por id para que el orden sea estable. */
function porMasReciente<T extends { createdAt: Date; paymentNumber: string }>(a: T, b: T): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || a.paymentNumber.localeCompare(b.paymentNumber);
}

/**
 * Cuántos pagos trae la consulta del admin, y hasta dónde se recorta la respuesta.
 *
 * La razón de que sean distintos está en `listPaymentsForAdmin`: sin índice compuesto no se puede
 * pedir `where("status", "==")` **ordenado por fecha**, así que Firestore devuelve en orden de
 * clave de documento (que aquí es el número de pago, o sea los más antiguos primero).
 */
const ADMIN_FETCH_LIMIT = 200;
const DEFAULT_ADMIN_LIMIT = 50;
const MAX_ADMIN_LIMIT = 200;

/**
 * Historial de pagos de un préstamo, del titular.
 *
 * El ownership se comprueba sobre el **préstamo**, no sobre cada pago: es una lectura y evita
 * además que el cliente pueda pedir el historial de un préstamo ajeno (404, igual que el detalle).
 * Las cuotas se leen una vez y se cruzan en memoria en vez de una lectura por pago.
 */
export async function listPaymentsForLoan(
  deps: PaymentListDeps,
  input: { loanId: string; userId: string },
): Promise<PaymentListItem[]> {
  const loan = await getLoanForUser(deps.db, input.userId, input.loanId);

  const [pagosSnap, cuotas] = await Promise.all([
    deps.db.collection("payments").where("loanId", "==", loan.id).get(),
    listInstallmentsForLoan(deps.db, loan.id),
  ]);
  const cuotaPorId = new Map(cuotas.map((cuota) => [cuota.id, cuota]));

  return pagosSnap.docs
    .map((doc): PaymentListItem | null => {
      const pago = doc.data() as PaymentDoc;
      const cuota = cuotaPorId.get(pago.installmentId);
      if (cuota === undefined) {
        // Un pago que apunta a una cuota que no existe no se puede mostrar con su número de cuota.
        // Es corrupción de datos, no un caso normal: mejor omitirlo en un listado que inventar.
        return null;
      }
      return {
        paymentId: doc.id,
        paymentNumber: pago.paymentNumber,
        amountPesos: pago.amountPesos,
        currency: pago.currency,
        channel: pago.channel,
        reference: pago.reference,
        status: pago.status,
        hasReceipt: paymentHasReceipt(pago),
        createdAt: toDate(pago.createdAt),
        installmentId: pago.installmentId,
        installmentNumber: cuota.installmentNumber,
        installmentStatus: cuota.status,
      };
    })
    .filter((item): item is PaymentListItem => item !== null)
    .sort(porMasReciente);
}

/**
 * Cola de pagos del admin.
 *
 * Por defecto solo `PENDING`: es lo que hay que resolver, y además mantiene la consulta selectiva
 * (un `where` de campo simple, sin índice compuesto) en vez de leer la colección entera. El filtro
 * es un `where` de un campo, así que cualquier estado pedido sigue usando índice automático.
 *
 * **Limitación conocida, y no es escondida**: sin el índice `status + createdAt` no se puede
 * pedir la cola ya ordenada por fecha, así que Firestore devuelve los `PENDING` en orden de clave
 * (número de pago: los más antiguos primero) y el recorte por `ADMIN_FETCH_LIMIT` deja fuera los
 * que excedan ese tope. En el MVP la cola se resuelve a mano y no llega a ese tamaño. Cuando lo
 * alcance, la respuesta es desplegar el índice compuesto de §8.2 con `roles/datastore.owner`, no
 * un `orderBy` esperanzado. Dentro de lo que sí se trae, el orden es el más reciente primero.
 */
export async function listPaymentsForAdmin(
  deps: PaymentListDeps,
  input: { status?: PaymentStatus; limit?: number } = {},
): Promise<AdminPaymentListItem[]> {
  const limit = normalizarLimite(input.limit);
  const estado = input.status ?? PaymentStatus.PENDING;

  const snap = await deps.db
    .collection("payments")
    .where("status", "==", estado)
    .limit(ADMIN_FETCH_LIMIT)
    .get();

  return snap.docs
    .map((doc) => {
      const pago = doc.data() as PaymentDoc;
      return {
        paymentId: doc.id,
        paymentNumber: pago.paymentNumber,
        userId: pago.userId,
        loanId: pago.loanId,
        installmentId: pago.installmentId,
        amountPesos: pago.amountPesos,
        currency: pago.currency,
        channel: pago.channel,
        reference: pago.reference,
        status: pago.status,
        hasReceipt: paymentHasReceipt(pago),
        createdAt: toDate(pago.createdAt),
        // Quién lo confirmó o rechazó. En un pago revertido sigue siendo quien confirmó: §8.1 no
        // guarda un `reversedBy`.
        resolvedBy: pago.confirmedBy ?? pago.rejectedBy,
        reason: pago.reason,
      };
    })
    .sort(porMasReciente)
    .slice(0, limit);
}

function normalizarLimite(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_ADMIN_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_ADMIN_LIMIT;
  return Math.min(limit, MAX_ADMIN_LIMIT);
}

/** Estados que la cola del admin sabe filtrar. */
export const ADMIN_PAYMENT_FILTERS: readonly PaymentStatus[] = [
  PaymentStatus.PENDING,
  PaymentStatus.CONFIRMED,
  PaymentStatus.REJECTED,
  PaymentStatus.REVERSED,
];
