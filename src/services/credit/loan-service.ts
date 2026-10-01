import type { Firestore, Transaction } from "firebase-admin/firestore";
import { stripUndefined } from "@/server/doc";
import { assertScheduleIsBalanced, buildLoanSchedule, type LoanSchedule } from "@/server/schedule";
import {
  ACTIVE_LOAN_STATUSES,
  buildLoanDoc,
  buildLoanInstallmentDoc,
  loanInstallmentDocId,
  type CreditProductDoc,
  type InterestRateDoc,
  type LoanApplicationDoc,
  type LoanDoc,
  type LoanInstallmentDoc,
} from "@/server/credit-doc";
import { ApplicationStatus, AuditAction, DelinquencyStatus, InstallmentStatus, LoanStatus } from "@/server/types";
import { conflict, notFound } from "@/lib/errors";
import { assertOwnedBy } from "@/server/ownership";

/**
 * Préstamos y cuotas (PROJECT_SPEC FASE 8).
 *
 * Invariante crítico: **un usuario solo puede tener un préstamo activo**. Firestore no
 * tiene índices únicos parciales, así que la invariante se aplica en transacción.
 *
 * El plan de amortización NO se recibe desde afuera: se genera en dominio puro
 * (`buildLoanSchedule`) con la tasa vigente y la tarifa del producto leídos dentro de la
 * misma transacción, para que el préstamo no dependa de lo que el calleronnieró.
 */

export interface CreateLoanInput {
  applicationId: string;
  loanId: string;
  loanNumber: string;
  now: Date;
  actorId: string;
  actorRole: string;
  /**
   * Base del calendario. Por defecto el instante de creación; el desembolso real ocurre
   * después (el préstamo arranca PENDING_DISBURSEMENT), así que el admin puede pasar la
   * fecha de desembolso cuando la confirme.
   */
  disbursementDate?: Date;
  /** Solo para tests: abre una ventana dentro de la transacción. */
  onBeforeWrite?: () => Promise<void>;
}

export interface CreateLoanResult {
  loan: LoanDoc;
  installments: LoanInstallmentDoc[];
  pricing: { annualRateBps: number; effectiveFeeBps: number; rateVersion: number };
}

function toMillis(value: unknown, context: string): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "object" && value !== null && "toMillis" in value) {
    const candidate = (value as { toMillis: () => number }).toMillis;
    if (typeof candidate === "function") {
      return candidate.call(value);
    }
  }
  throw conflict(`Fecha ilegible en ${context}`);
}

interface Pricing {
  annualRateBps: number;
  effectiveFeeBps: number;
  rateVersion: number;
}

/**
 * Resuelve la tarifa del producto y la tasa vigente.
 *
 * La tasa se busca con una query de un solo campo (`productType`) y se filtra en memoria a
 * propósito: filtrar por `productType + isActive + version` en Firestore exige índice
 * compuesto, y los índices del proyecto no están desplegados (`roles/datastore.owner`
 * falta). Con few rates por producto, filtrar en memoria es correcto y barato.
 */
export async function resolvePricing(
  db: Firestore,
  tx: Transaction,
  productId: string,
  now: Date,
): Promise<Pricing> {
  const productSnap = await tx.get(db.collection("credit_products").doc(productId));
  if (!productSnap.exists) {
    throw notFound(`Producto de crédito no encontrado: ${productId}`);
  }
  const product = productSnap.data() as CreditProductDoc;
  if (!product.isActive) {
    throw conflict(`El producto de crédito ${productId} no está activo`);
  }

  const rateSnap = await tx.get(
    db.collection("interest_rates").where("productType", "==", productId),
  );
  const nowMs = now.getTime();
  const vigente = rateSnap.docs
    .map((doc) => doc.data() as InterestRateDoc)
    .filter((rate) => rate.isActive)
    .filter((rate) => toMillis(rate.effectiveFrom, "interest_rates.effectiveFrom") <= nowMs)
    .filter(
      (rate) =>
        rate.effectiveTo === undefined ||
        toMillis(rate.effectiveTo, "interest_rates.effectiveTo") > nowMs,
    )
    .sort((a, b) => b.version - a.version);

  const rate = vigente[0];
  if (!rate) {
    throw conflict(`No hay tasa de interés activa y vigente para el producto ${productId}`);
  }
  return { annualRateBps: rate.annualRateBps, effectiveFeeBps: product.effectiveFeeBps, rateVersion: rate.version };
}

/**
 * Lee los préstamos activos del usuario DENTRO de la transacción y es la comprobación
 * autoritativa del invariante "un préstamo activo".
 *
 * No hay índices únicos parciales en Firestore, así que la garantía depende de la
 * transacción. Verificado contra Firestore real con dos creaciones concurrentes y una
 * ventana de 1.5 s dentro de la transacción: exactamente una pasa. Ese test falla (se
 * crean dos préstamos activos) si se quita esta comprobación, así que no es un test
 * vacuous. Aun así, si en el futuro se observara que la comprobación no serializa bajo
 * otra forma de carrera, el refuerzo es tomar un doc por usuario (p. ej. escribir
 * `users/{uid}`) en la misma transacción para forzar el conflicto de versión.
 */
export async function findActiveLoanForUser(
  db: Firestore,
  tx: Transaction,
  userId: string,
): Promise<string | undefined> {
  const snap = await tx.get(
    db
      .collection("loans")
      .where("userId", "==", userId)
      .where("status", "in", ACTIVE_LOAN_STATUSES as unknown as string[]),
  );
  return snap.docs[0]?.id;
}

export async function assertNoActiveLoan(
  db: Firestore,
  tx: Transaction,
  userId: string,
): Promise<void> {
  const activeLoanId = await findActiveLoanForUser(db, tx, userId);
  if (activeLoanId) {
    throw conflict("El usuario ya tiene un préstamo activo");
  }
}

/**
 * Defensa en profundidad: aunque `buildLoanSchedule` ya garantiza la suma exacta, el
 * servicio la revalida sobre los docs que va a escribir. Un bug de redondeo no puede
 * llegar a Firestore.
 */
function assertScheduleMatchesLoan(schedule: LoanSchedule): void {
  try {
    assertScheduleIsBalanced(schedule);
  } catch {
    throw conflict(
      "El plan de pagos no cuadra con los importes del préstamo (capital, intereses, comisiones o total)",
    );
  }
}

export async function createLoanFromApprovedApplication(
  db: Firestore,
  input: CreateLoanInput,
): Promise<CreateLoanResult> {
  return db.runTransaction(async (tx) => {
    const applicationRef = db.collection("loan_applications").doc(input.applicationId);
    const applicationSnap = await tx.get(applicationRef);
    if (!applicationSnap.exists) {
      throw notFound("Solicitud no encontrada");
    }
    const application = applicationSnap.data() as LoanApplicationDoc;
    if (application.status !== ApplicationStatus.APPROVED) {
      throw conflict("Solo una solicitud APPROVED genera un préstamo");
    }

    await assertNoActiveLoan(db, tx, application.userId);

    const pricing = await resolvePricing(db, tx, application.productId, input.now);

    if (input.onBeforeWrite) {
      await input.onBeforeWrite();
    }

    const schedule = buildLoanSchedule({
      principalPesos: application.requestedAmountPesos,
      annualRateBps: pricing.annualRateBps,
      effectiveFeeBps: pricing.effectiveFeeBps,
      termInstallments: application.termInstallments,
      termFrequency: application.termFrequency,
      disbursementDate: input.disbursementDate ?? input.now,
    });
    assertScheduleMatchesLoan(schedule);

    const loan = buildLoanDoc(
      {
        loanNumber: input.loanNumber,
        applicationId: input.applicationId,
        userId: application.userId,
        productCode: application.productId,
        principalPesos: schedule.principalPesos,
        interestPesos: schedule.interestPesos,
        feePesos: schedule.feePesos,
        // Se congela la base de cálculo APLICADA (la que hoy está vigente), no la que pueda
        // estarlo en F9. El recálculo del calendario la usa tal cual.
        pricing: {
          annualRateBps: pricing.annualRateBps,
          effectiveFeeBps: pricing.effectiveFeeBps,
          rateVersion: pricing.rateVersion,
          termInstallments: application.termInstallments,
          termFrequency: application.termFrequency,
        },
        status: LoanStatus.PENDING_DISBURSEMENT,
        delinquencyStatus: DelinquencyStatus.CURRENT,
        daysPastDue: 0,
        outstandingPesos: schedule.totalPayablePesos,
      },
      input.now,
    );

    const loanRef = db.collection("loans").doc(input.loanId);
    tx.set(loanRef, stripUndefined(loan));

    const installments = schedule.installments.map((cuota) =>
      buildLoanInstallmentDoc({
        loanId: input.loanId,
        installmentNumber: cuota.installmentNumber,
        dueDate: cuota.dueDate,
        principalPesos: cuota.principalPesos,
        interestPesos: cuota.interestPesos,
        feePesos: cuota.feePesos,
      }),
    );
    for (const installment of installments) {
      tx.set(
        db
          .collection("loan_installments")
          .doc(loanInstallmentDocId(installment.loanId, installment.installmentNumber)),
        stripUndefined(installment),
      );
    }

    tx.set(db.collection("audit_logs").doc(), {
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: AuditAction.LOAN_STATUS_CHANGED,
      entityType: "loan",
      entityId: loan.loanNumber,
      metadata: {
        fromStatus: null,
        toStatus: LoanStatus.PENDING_DISBURSEMENT,
        applicationId: input.applicationId,
        productCode: application.productId,
        principalPesos: schedule.principalPesos,
        interestPesos: schedule.interestPesos,
        feePesos: schedule.feePesos,
        totalPayablePesos: loan.totalPayablePesos,
        installmentCount: installments.length,
        annualRateBps: pricing.annualRateBps,
        effectiveFeeBps: pricing.effectiveFeeBps,
        rateVersion: pricing.rateVersion,
      },
      createdAt: input.now,
    });

    return { loan, installments, pricing };
  });
}

/* ==================== Lectura para el cliente (F8-3) ==================== */

export type LoanWithId = LoanDoc & { id: string };
export type InstallmentWithId = LoanInstallmentDoc & { id: string };

/**
 * Préstamos del usuario, del más nuevo al más viejo.
 *
 * Se filtra solo por `userId` (índice simple) y se ordena en memoria a propósito: añadir
 * `orderBy("createdAt")` exigiría el índice compuesto `[userId, createdAt]`, que no está
 * desplegado porque falta `roles/datastore.owner`. Un usuario tiene un puñado de préstamos,
 * así que ordenar en memoria no cambia el resultado y evita un 500. El desempate por `id`
 * hace el orden estable cuando dos préstamos comparten `createdAt`.
 */
export async function listLoansForUser(db: Firestore, userId: string): Promise<LoanWithId[]> {
  const snap = await db.collection("loans").where("userId", "==", userId).get();
  return snap.docs
    .map((doc) => ({ ...(doc.data() as LoanDoc), id: doc.id }))
    .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt) || a.id.localeCompare(b.id));
}

function timeOf(value: LoanDoc["createdAt"]): number {
  return toDate(value).getTime();
}

/** Normaliza `CreditDocDate` (Date o Timestamp de Firestore) a `Date`. */
function toDate(value: LoanDoc["createdAt"]): Date {
  return value instanceof Date ? value : new Date(value.toMillis());
}

/**
 * Préstamo de un cliente, con ownership verificado.
 *
 * 404 tanto si no existe como si es de otro usuario: un 403 revelaría la existencia del
 * préstamo ajeno. Ver `assertOwnedBy`.
 */
export async function getLoanForUser(
  db: Firestore,
  userId: string,
  loanId: string,
): Promise<LoanWithId> {
  const snap = await db.collection("loans").doc(loanId).get();
  const loan = snap.exists ? ({ ...(snap.data() as LoanDoc), id: snap.id } as LoanWithId) : null;
  return assertOwnedBy(loan, userId, "Préstamo no encontrado");
}

/** Cuotas de un préstamo en orden de cuota. Usa el índice simple `loanId`. */
export async function listInstallmentsForLoan(
  db: Firestore,
  loanId: string,
): Promise<InstallmentWithId[]> {
  const snap = await db.collection("loan_installments").where("loanId", "==", loanId).get();
  return snap.docs
    .map((doc) => ({ ...(doc.data() as LoanInstallmentDoc), id: doc.id }))
    .sort((a, b) => a.installmentNumber - b.installmentNumber);
}

/** Primera cuota pendiente por vencimiento, o `undefined` si el préstamo está saldado. */
export function findNextInstallment(installments: InstallmentWithId[]): InstallmentWithId | undefined {
  return installments
    .filter((cuota) => cuota.status === InstallmentStatus.PENDING)
    .sort((a, b) => timeOfInstallment(a.dueDate) - timeOfInstallment(b.dueDate))[0];
}

function timeOfInstallment(value: LoanInstallmentDoc["dueDate"]): number {
  return toDate(value).getTime();
}

export interface LoanSummary {
  loan: LoanWithId;
  installments: InstallmentWithId[];
  nextDueAt?: Date;
  nextInstallmentId?: string;
  installmentCount: number;
  paidInstallments: number;
  outstandingPesos: number;
}

/**
 * Vista de detalle para la UI: el préstamo, su calendario de cuotas y el próximo
 * vencimiento.
 *
 * `nextDueAt` NO se persiste en el doc del préstamo: se deriva de la primera cuota
 * pendiente, que es la única fuente de verdad. Si las cuotas se recalculan al confirmar el
 * desembolso (F9), el próximo vencimiento se mueve solo.
 */
export async function summarizeLoan(
  db: Firestore,
  userId: string,
  loanId: string,
): Promise<LoanSummary> {
  const loan = await getLoanForUser(db, userId, loanId);
  const installments = await listInstallmentsForLoan(db, loanId);
  const next = findNextInstallment(installments);
  return {
    loan,
    installments,
    nextDueAt: next ? toDate(next.dueDate) : undefined,
    nextInstallmentId: next?.id,
    installmentCount: installments.length,
    paidInstallments: installments.filter((c) => c.status === InstallmentStatus.PAID).length,
    outstandingPesos: loan.outstandingPesos ?? 0,
  };
}
