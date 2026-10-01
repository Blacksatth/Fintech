import { DelinquencyStatus, LoanStatus, type RiskLevel } from "./types";
import { add, mul, roundDiv, sub } from "./money";

/**
 * Métricas de cartera (PROJECT_SPEC §13). Dominio puro: sin Firebase ni Next, para que las
 * definiciones se prueben sin infraestructura.
 *
 * Las definiciones de §13 son: cartera total (saldo por cobrar), vigente, vencida, en mora,
 * desembolsado acumulado, recuperado acumulado, saldo pendiente, tasa de mora (vencido/total),
 * tasa de recuperación (recuperado/desembolsado), préstamos activos/pagados/incumplidos,
 * pérdida de cartera, rendimiento.
 *
 * El servicio (`portfolio-service.ts`) construye los `PortfolioLoan` desde la **caché** de `loans`
 * (+ el join del score para el riesgo) y aplica los filtros; este módulo solo entraga las métricas.
 * Como en `client-dashboard.ts` y `delinquency.ts`, los pesos se suman con `add` y los ratios se
 * emiten en basis points con `roundDiv`: nada flota ni céntimos (trampa de negocio del proyecto).
 *
 * Definiciones concretas (banco que las pruebas fijan):
 *
 * - `carteraTotalPesos` ("saldo por cobrar"): Σ `outstandingPesos` de préstamos **cobrables**
 *   (`DISBURSED`/`DEFAULTED`). Excluye `PENDING_DISBURSEMENT` (no hay saldo), `PAID` (saldado)
 *   y `WRITTEN_OFF` (condonado: su saldo es `perdidaCarteraPesos`).
 * - `vigentePesos`: Σ outstanding de los cobrables con mora `CURRENT|DUE_SOON|DUE_TODAY`.
 * - `vencidaPesos`: Σ outstanding de los cobrables con mora `OVERDUE|DEFAULT`.
 * - `enMoraPesos`: Σ outstanding de los cobrables con mora `DEFAULT`.
 *   → `vigente + vencida = cartera` (partición) y `en mora ⊆ vencida`.
 * - `desembolsadoAcumuladoPesos`: Σ `principalPesos` de los préstamos **desembolsados** (todo
 *   `status != PENDING_DISBURSEMENT`). Histórico: incluye pagados, incumplidos y condonados.
 * - `recuperadoAcumuladoPesos`: Σ `máx(0, totalPayable − outstanding)` de los desembolsados,
 *   donde `totalPayable = principal + interés + tarifa` (snapshot congelado). Son los pesos que el
 *   negocio ya cobró en efectivo, intereses y tarifas incluidos.
 * - `saldoPendientePesos`: Σ `outstandingPesos` de **todos** los desembolsados (incluye la
 *   condonación). Es el espejo del recuperado: `recuperado + saldoPendiente = Σ totalPayable`
 *   (cuando ningún préstamo está corrupto).
 * - `tasaMoraBps` = `roundDiv(vencida × 10000 / cartera)`, 0 si no hay cartera.
 * - `tasaRecuperacionBps` = `roundDiv(recuperado × 10000 / desembolsado)`, 0 si no se desembolsó.
 *   Puede superar 10 000 bps porque el numerador incluye el sobrante (interés/tarifa) cobrado
 *   frente al monto en principal que se confió; se documenta y se muestra como "de lo confiado
 *   ya se cobró el X% en efectivo".
 * - `prestamosActivos`: conteo de cobrables (`DISBURSED`/`DEFAULTED`).
 * - `prestamosPagados`: conteo de `PAID`.
 * - `prestamosIncumplidos`: conteo de `DEFAULTED`.
 * - `perdidaCarteraPesos`: Σ `outstandingPesos` de `WRITTEN_OFF` (lo condonado, lo que no se cobra).
 * - `rendimientoBps` = `roundDiv(Σ(interés+tarifa) de desembolsados × 10000 / Σ principal
 *   desembolsado)`: rentabilidad **pactada** del contrato sobre el principal, medible con el
 *   snapshot del préstamo sin leer cuotas.
 *
 * Las particiones `byDelinquencyStatus`/`byLoanStatus`/`byRiskLevel` y `maxDaysPastDue` son
 * auxiliares para el dashboard: cuentan sobre el conjunto completo, antes de partir por `status`
 * (un préstamo sin score no entra en `byRiskLevel`).
 */

export interface PortfolioLoan {
  id: string;
  status: LoanStatus;
  principalPesos: number;
  interestPesos: number;
  feePesos: number;
  /** Saldo por cobrar cacheado en `loans.outstandingPesos` (lo escriben los servicios). */
  outstandingPesos: number;
  delinquencyStatus: DelinquencyStatus;
  daysPastDue: number;
  /** `undefined` si el préstamo no tiene score (join perdido con `credit_scores`). */
  riskLevel?: RiskLevel;
  /** `undefined` si el préstamo nunca se desembolsó. */
  disbursedAtMs?: number;
}

export interface PortfolioMetrics {
  carteraTotalPesos: number;
  vigentePesos: number;
  vencidaPesos: number;
  enMoraPesos: number;
  desembolsadoAcumuladoPesos: number;
  recuperadoAcumuladoPesos: number;
  saldoPendientePesos: number;
  tasaMoraBps: number;
  tasaRecuperacionBps: number;
  prestamosActivos: number;
  prestamosPagados: number;
  prestamosIncumplidos: number;
  perdidaCarteraPesos: number;
  rendimientoBps: number;
  byDelinquencyStatus: Record<DelinquencyStatus, number>;
  byLoanStatus: Partial<Record<LoanStatus, number>>;
  byRiskLevel: Record<RiskLevel, number>;
  maxDaysPastDue: number;
}

function emptyCounters() {
  return {
    byDelinquencyStatus: {
      CURRENT: 0,
      DUE_SOON: 0,
      DUE_TODAY: 0,
      OVERDUE: 0,
      DEFAULT: 0,
      PAID: 0,
    } as Record<DelinquencyStatus, number>,
    byRiskLevel: { LOW: 0, MEDIUM: 0, HIGH: 0 } as Record<RiskLevel, number>,
  };
}

export function calculatePortfolioMetrics(loans: readonly PortfolioLoan[]): PortfolioMetrics {
  const { byDelinquencyStatus, byRiskLevel } = emptyCounters();
  const byLoanStatus: Partial<Record<LoanStatus, number>> = {};

  let carteraTotalPesos = 0;
  let vigentePesos = 0;
  let vencidaPesos = 0;
  let enMoraPesos = 0;
  let desembolsadoAcumuladoPesos = 0;
  let recuperadoAcumuladoPesos = 0;
  let saldoPendientePesos = 0;
  let surplusPesos = 0;
  let prestamosActivos = 0;
  let prestamosPagados = 0;
  let prestamosIncumplidos = 0;
  let perdidaCarteraPesos = 0;
  let maxDaysPastDue = 0;

  for (const loan of loans) {
    // invariant de dinero del snapshot: totalPayable = principal + interés + tarifa.
    const totalPayable = add(add(loan.principalPesos, loan.interestPesos), loan.feePesos);

    byDelinquencyStatus[loan.delinquencyStatus] += 1;
    byLoanStatus[loan.status] = (byLoanStatus[loan.status] ?? 0) + 1;
    if (loan.riskLevel !== undefined) byRiskLevel[loan.riskLevel] += 1;
    if (loan.daysPastDue > maxDaysPastDue) maxDaysPastDue = loan.daysPastDue;

    if (loan.status === LoanStatus.PAID) prestamosPagados += 1;
    if (loan.status === LoanStatus.DEFAULTED) prestamosIncumplidos += 1;
    if (loan.status === LoanStatus.WRITTEN_OFF) {
      perdidaCarteraPesos = add(perdidaCarteraPesos, loan.outstandingPesos);
    }

    const desembolsado = loan.status !== LoanStatus.PENDING_DISBURSEMENT;
    if (!desembolsado) continue;

    desembolsadoAcumuladoPesos = add(desembolsadoAcumuladoPesos, loan.principalPesos);
    surplusPesos = add(surplusPesos, add(loan.interestPesos, loan.feePesos));
    recuperadoAcumuladoPesos = add(
      recuperadoAcumuladoPesos,
      Math.max(0, sub(totalPayable, loan.outstandingPesos)),
    );
    saldoPendientePesos = add(saldoPendientePesos, loan.outstandingPesos);

    const cobrable = loan.status === LoanStatus.DISBURSED || loan.status === LoanStatus.DEFAULTED;
    if (!cobrable) continue;

    prestamosActivos += 1;
    carteraTotalPesos = add(carteraTotalPesos, loan.outstandingPesos);
    if (
      loan.delinquencyStatus === DelinquencyStatus.OVERDUE ||
      loan.delinquencyStatus === DelinquencyStatus.DEFAULT
    ) {
      vencidaPesos = add(vencidaPesos, loan.outstandingPesos);
    } else {
      vigentePesos = add(vigentePesos, loan.outstandingPesos);
    }
    if (loan.delinquencyStatus === DelinquencyStatus.DEFAULT) {
      enMoraPesos = add(enMoraPesos, loan.outstandingPesos);
    }
  }

  return {
    carteraTotalPesos,
    vigentePesos,
    vencidaPesos,
    enMoraPesos,
    desembolsadoAcumuladoPesos,
    recuperadoAcumuladoPesos,
    saldoPendientePesos,
    tasaMoraBps: carteraTotalPesos > 0 ? roundDiv(mul(vencidaPesos, 10_000), carteraTotalPesos) : 0,
    tasaRecuperacionBps:
      desembolsadoAcumuladoPesos > 0
        ? roundDiv(mul(recuperadoAcumuladoPesos, 10_000), desembolsadoAcumuladoPesos)
        : 0,
    prestamosActivos,
    prestamosPagados,
    prestamosIncumplidos,
    perdidaCarteraPesos,
    rendimientoBps:
      desembolsadoAcumuladoPesos > 0
        ? roundDiv(mul(surplusPesos, 10_000), desembolsadoAcumuladoPesos)
        : 0,
    byDelinquencyStatus,
    byLoanStatus,
    byRiskLevel,
    maxDaysPastDue,
  };
}