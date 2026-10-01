import type { Firestore } from "firebase-admin/firestore";
import { calculatePortfolioMetrics, type PortfolioLoan, type PortfolioMetrics } from "@/server/portfolio-math";
import type { CreditDocDate, LoanDoc } from "@/server/credit-doc";
import { DelinquencyStatus, LoanStatus, RiskLevel, type RiskLevel as RiskLevelType } from "@/server/types";

/**
 * Métricas de cartera para el admin (PROJECT_SPEC §13 / §8 `GET /api/admin/portfolio`).
 *
 * Es el otro lado de `delinquency-service.ts`: allá se recalcula la mora al vuelo; acá se agregan
 * las horas de negocio (cartera, recuperación, pérdida, rendimiento). Como el §13 pide, la lectura
 * usa la **caché** de `loans` (`outstandingPesos`/`delinquencyStatus`/`daysPastDue`) y el único
 * join extra es el `riskLevel` del score (`credit_scores/{applicationId}`, un `getAll` sin índice).
 *
 * Convenciones del proyecto que se respetan:
 *
 * - **Sin índices compuestos**: los préstamos se leen con cinco consultas de igualdad de un solo
 *   campo (una por `status`, índice automático) y se ordenan/filtran en memoria.
 * - **Un préstamo roto no tumba la cartera**: los documentos previos al esquema actual (sin campos
 *   de dinero) no pueden alimentar métricas en pesos y se cuentan en `skippedLegacy`, igual que la
 *   fila con `error` que la pantalla de mora muestra en lugar de romper el resumen.
 * - **Tope operativo**: pasado `PORTFOLIO_SCAN_LIMIT` por estado la agregación sería una cartera
 *   a medias; se marca `truncated` para que el dashboard no venda números parciales como ciertos.
 */

export interface PortfolioDeps {
  db: Firestore;
}

export interface PortfolioFilters {
  /** Rango sobre la fecha de desembolso del préstamo, en ms (inclusivo). */
  disbursedFromMs?: number;
  disbursedToMs?: number;
  /** Estado del préstamo (`LoanStatus`). */
  status?: LoanStatus;
  /** Perfil de riesgo del score de la solicitud (`credit_scores/{applicationId}`). */
  riskLevel?: RiskLevel;
  /** Rango sobre el principal desembolsado, en pesos (inclusivo). */
  minPrincipalPesos?: number;
  maxPrincipalPesos?: number;
  /** Estado de mora cacheado por los servicios de recálculo. */
  delinquencyStatus?: DelinquencyStatus;
  /** Rango de días de atraso (inclusivo). */
  minDaysPastDue?: number;
  maxDaysPastDue?: number;
}

export interface PortfolioResult {
  metrics: PortfolioMetrics;
  /** Préstamos que alimentaron las métricas tras aplicar los filtros. */
  loans: PortfolioLoan[];
  /** Documentos de `loans` leídos que no tenían esquema de dinero (no cuentan). */
  skippedLegacy: number;
  /** `true` si algún estado superó el tope de lectura: las métricas están incompletas. */
  truncated: boolean;
}

/** Techo de préstamos leídos por pasada y por estado (vista operativa con tope). */
export const PORTFOLIO_SCAN_LIMIT = 1000;

const LOAN_STATUSES = Object.values(LoanStatus) as LoanStatus[];

function toMillis(value: CreditDocDate | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis(): number }).toMillis();
  }
  return (value as Date).getTime();
}

/** Un doc de `loans` alimenta métricas si tiene los pesos del snapshot (esquema de dinero). */
function hasMoneyFields(loan: LoanDoc): boolean {
  return [loan.principalPesos, loan.interestPesos, loan.feePesos, loan.totalPayablePesos].every(
    (value) => Number.isSafeInteger(value),
  );
}

function normalizeLoan(doc: LoanDoc & { id: string }): PortfolioLoan {
  const totalPayable = doc.principalPesos + doc.interestPesos + doc.feePesos;
  return {
    id: doc.id,
    status: doc.status,
    principalPesos: doc.principalPesos,
    interestPesos: doc.interestPesos,
    feePesos: doc.feePesos,
    outstandingPesos: doc.outstandingPesos ?? totalPayable,
    delinquencyStatus: doc.delinquencyStatus ?? DelinquencyStatus.CURRENT,
    daysPastDue: doc.daysPastDue ?? 0,
    disbursedAtMs: toMillis(doc.disbursedAt),
  };
}

/** Perfil de riesgo por `applicationId`, en un solo `getAll` (sin índices). */
async function readRiskLevels(db: Firestore, applicationIds: readonly string[]): Promise<Map<string, RiskLevelType>> {
  const result = new Map<string, RiskLevelType>();
  const unique = [...new Set(applicationIds.filter((id) => id.length > 0))];
  if (unique.length === 0) return result;
  const snaps = await db.getAll(...unique.map((id) => db.collection("credit_scores").doc(id)));
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const data = snap.data() as { riskLevel?: unknown };
    const level = data.riskLevel;
    if (level === RiskLevel.LOW || level === RiskLevel.MEDIUM || level === RiskLevel.HIGH) {
      result.set(snap.id, level);
    }
  }
  return result;
}

function matchesFilters(loan: PortfolioLoan, filters: PortfolioFilters): boolean {
  if (filters.status !== undefined && loan.status !== filters.status) return false;
  if (filters.riskLevel !== undefined && loan.riskLevel !== filters.riskLevel) return false;
  if (filters.delinquencyStatus !== undefined && loan.delinquencyStatus !== filters.delinquencyStatus) {
    return false;
  }
  if (filters.disbursedFromMs !== undefined && (loan.disbursedAtMs ?? -Infinity) < filters.disbursedFromMs) {
    return false;
  }
  if (filters.disbursedToMs !== undefined && (loan.disbursedAtMs ?? Infinity) > filters.disbursedToMs) {
    return false;
  }
  if (filters.minPrincipalPesos !== undefined && loan.principalPesos < filters.minPrincipalPesos) return false;
  if (filters.maxPrincipalPesos !== undefined && loan.principalPesos > filters.maxPrincipalPesos) return false;
  if (filters.minDaysPastDue !== undefined && loan.daysPastDue < filters.minDaysPastDue) return false;
  if (filters.maxDaysPastDue !== undefined && loan.daysPastDue > filters.maxDaysPastDue) return false;
  return true;
}

export async function getPortfolioMetrics(
  deps: PortfolioDeps,
  options: { filters?: PortfolioFilters } = {},
): Promise<PortfolioResult> {
  const filters = options.filters ?? {};
  const base = deps.db.collection("loans");

  // Lectura por estado con igualdad de un solo campo (índice automático, siempre disponible).
  const snaps = await Promise.all(
    LOAN_STATUSES.map((status) => base.where("status", "==", status).limit(PORTFOLIO_SCAN_LIMIT).get()),
  );
  const truncated = snaps.some((snap) => snap.size >= PORTFOLIO_SCAN_LIMIT);

  const valid: Array<{ loan: PortfolioLoan; applicationId: string }> = [];
  let skippedLegacy = 0;

  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const data = doc.data() as LoanDoc;
      if (!hasMoneyFields(data)) {
        skippedLegacy += 1;
        continue;
      }
      valid.push({ loan: normalizeLoan({ ...data, id: doc.id }), applicationId: data.applicationId ?? "" });
    }
  }

  const riskLevels = await readRiskLevels(
    deps.db,
    valid.map((item) => item.applicationId),
  );
  for (const item of valid) {
    item.loan.riskLevel = riskLevels.get(item.applicationId);
  }

  const loans = valid.map((item) => item.loan).filter((loan) => matchesFilters(loan, filters));
  const metrics = calculatePortfolioMetrics(loans);

  return { metrics, loans, skippedLegacy, truncated };
}