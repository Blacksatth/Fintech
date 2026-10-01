import { type Firestore } from "firebase-admin/firestore";
import {
  buildLoanSchedule,
  MONTHS_PER_YEAR,
  periodRateBpsFor,
  type LoanSchedule,
} from "@/server/schedule";
import { type CreditProductDoc } from "@/server/credit-doc";
import { TermFrequency } from "@/server/types";
import { validateApplicationTerm } from "@/server/loan-application";
import { termFrequencyLabel } from "@/lib/credit-labels";
import { badRequest, notFound } from "@/lib/errors";
import { resolvePricing } from "./loan-service";

export interface LoanQuoteInstallment {
  installmentNumber: number;
  /** Fecha estimada del vencimiento (UTC). El plan definitivo se fija al desembolsar. */
  dueDateIso: string;
  totalPesos: number;
}

export interface LoanQuote {
  productId: string;
  amountPesos: number;
  termInstallments: number;
  termFrequency: TermFrequency;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  totalPayablePesos: number;
  /** Cuota de cada periodo de pago (nivel del plan). Con frecuencia mensual, la cuota mensual. */
  monthlyInstallmentPesos: number;
  /** Tasa anual vigente aplicada a este plan (bps enteros). */
  annualRateBps: number;
  /** Tarifa efectiva del producto (bps enteros), cobrada una vez sobre el capital. */
  effectiveFeeBps: number;
  /**
   * Tasa **por periodo de pago**, que es la que cobra el calendario (`annualRateBps` prorrateada
   * entre los periodos del año). Con frecuencia mensual es 12 periodos y coincide con
   * `monthlyRateBps`.
   */
  periodRateBps: number;
  /**
   * Equivalente mensual de la tasa anual (`annualRateBps / 12`), para comparar productos de
   * distinta frecuencia sin tener que mirar el calendario. Es una referencia, no lo que se cobra
   * en un producto semanal o quincenal: ahí lo que se cobra es `periodRateBps`.
   */
  monthlyRateBps: number;
  installments: LoanQuoteInstallment[];
}

export interface QuoteLoanPlanInput {
  productId: string;
  amountPesos: number;
  termInstallments: number;
}

/**
 * Cotización del plan de pagos para el formulario de solicitud (preview).
 *
 * Usa la MISMA fuente de verdad que la creación real del préstamo: `resolvePricing`
 * (tarifa del producto + tasa vigente, igual que `createLoanFromApprovedApplication`) y
 * `buildLoanSchedule`. Así "cómo quedará" que ve el cliente coincide con el calendario
 * que se genera al aprobar, en lugar de un estimado calcado a mano.
 *
 * Las fechas del preview son estimadas (el desembolso todavía no existe); los pesos, no:
 * el plan de amortización no depende de la fecha de desembolso (`buildLoanSchedule`).
 */
export async function quoteLoanPlan(
  db: Firestore,
  input: QuoteLoanPlanInput,
  now: Date,
): Promise<LoanQuote> {
  const productSnap = await db.collection("credit_products").doc(input.productId).get();
  if (!productSnap.exists) {
    throw notFound("Producto no encontrado");
  }
  const product = productSnap.data() as CreditProductDoc;
  if (!product.isActive) {
    throw badRequest("Producto inactivo");
  }

  const termValidation = validateApplicationTerm(
    product,
    input.termInstallments,
    product.termFrequency,
    termFrequencyLabel,
  );
  if (!termValidation.valid) {
    throw badRequest(termValidation.reason);
  }

  const tiersSnap = await db
    .collection("product_tiers")
    .where("productCode", "==", input.productId)
    .where("isActive", "==", true)
    .get();
  const amountIsATier = tiersSnap.docs.some(
    (doc) => doc.data().amountPesos === input.amountPesos,
  );
  if (!amountIsATier) {
    throw badRequest("El monto no corresponde a un tier activo del producto");
  }

  const pricing = await db.runTransaction((tx) =>
    resolvePricing(db, tx, input.productId, now),
  );

  const schedule: LoanSchedule = buildLoanSchedule({
    principalPesos: input.amountPesos,
    annualRateBps: pricing.annualRateBps,
    effectiveFeeBps: pricing.effectiveFeeBps,
    termInstallments: input.termInstallments,
    termFrequency: product.termFrequency,
    disbursementDate: now,
  });

  return {
    productId: input.productId,
    amountPesos: input.amountPesos,
    termInstallments: input.termInstallments,
    termFrequency: product.termFrequency,
    principalPesos: schedule.principalPesos,
    interestPesos: schedule.interestPesos,
    feePesos: schedule.feePesos,
    totalPayablePesos: schedule.totalPayablePesos,
    monthlyInstallmentPesos: schedule.installments[0].totalPesos,
    annualRateBps: pricing.annualRateBps,
    effectiveFeeBps: pricing.effectiveFeeBps,
    periodRateBps: periodRateBpsFor(pricing.annualRateBps, product.termFrequency),
    monthlyRateBps: Math.floor(pricing.annualRateBps / MONTHS_PER_YEAR),
    installments: schedule.installments.map((cuota) => ({
      installmentNumber: cuota.installmentNumber,
      dueDateIso: cuota.dueDate.toISOString(),
      totalPesos: cuota.totalPesos,
    })),
  };
}