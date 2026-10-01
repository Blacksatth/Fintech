import { type Firestore } from "firebase-admin/firestore";
import { ACTIVE_LOAN_STATUSES, loanInstallmentDocId } from "@/server/credit-doc";
import type { LoanDoc, LoanInstallmentDoc, SystemConfigDoc } from "@/server/credit-doc";
import { formatDueDate, toDate } from "@/lib/credit-labels";
import { formatPesos } from "@/server/money";
import { AuditAction, DelinquencyStatus, type LoanStatus } from "@/server/types";
import {
  DELINQUENCY_STATUSES,
  daysPastDueForInstallment,
  parseDelinquencyThresholds,
  recalcLoanDelinquency,
  summarizeDelinquency,
  wholeDaysBetween,
  type DelinquencyThresholds,
  type LoanDelinquencyResult,
  type PortfolioSummary,
} from "@/server/delinquency";
import { installmentReminderRefKey, NotificationType } from "@/server/notification-doc";
import { conflict, notFound } from "@/lib/errors";
import { isLoanCacheStale, loanRecalcPatch } from "@/services/credit/loan-recalc";
import {
  notifyUser,
  defaultProviders,
  type NotificationDeps,
  type NotificationProvider,
} from "@/services/notifications/notification-service";
import type { UserDoc } from "@/server/user-doc";

/**
 * Cartera de mora (PROJECT_SPEC §13, F11): recálculo **bajo demanda** y lectura para el admin.
 *
 * El recálculo después de confirmar un pago ya existe y va dentro de la transacción del pago
 * (F10-2b). Lo que falta —y lo que hace este servicio— es el otro lado del §13: refreshing la
 * caché cuando el día cambia. Un préstamo que se venció ayer sin que nadie pague sigue diciendo
 * `CURRENT` en `loans` para siempre, porque nadie pasó por el servicio de pagos; los filtros de la
 * cartera (y las métricas de F13) se comen ese dato viejo.
 *
 * Dos caminos, a propósito:
 *
 * - **Lectura en fresco** (`listDelinquencyForAdmin`): recalcula en memoria y **no escribe**. La
 *   pantalla de mora nunca muestra un día de atraso viejo, y abrir una pantalla no ensucia la
 *   colección.
 * - **Escritura explícita** (`recalcActivePortfolio`, botón "Recalcular cartera"): persiste la
 *   caché y dispara los avisos de cuota, con auditoría. Un Server Component no debería mutar
 *   datos como efecto secundario de que alguien mire una tabla.
 */

export interface DelinquencyDeps extends NotificationDeps {
  /**
   * Proveedores de notificación alternos. Está como opción para que las pruebas no impriman el
   * log del proveedor y para poder añadir un canal real (email, §16) sin tocar el recálculo.
   */
  notifyProviders?: readonly NotificationProvider[];
}

/**
 * Techo de préstamos leídos por pasada. No es un export: es una vista operativa con tope, como
 * `ADMIN_LOAN_LIST_LIMIT`. Con más cartera que este número habría que paginar (y el resumen
 * avisaría con `truncated`), no leerla entera en cada render.
 */
export const DELINQUENCY_SCAN_LIMIT = 200;

export interface DelinquencyRow {
  loanId: string;
  loanNumber: string;
  userId: string;
  principalPesos?: number;
  loanStatus: LoanStatus;
  /** `null` si este préstamo no se pudo calcular: la fila lo explica en `error`. */
  recalc: LoanDelinquencyResult | null;
  error?: string;
  /** Próxima cuota impaga (la más antigua sin pagar), que es la que exige atención. */
  nextInstallment: LoanInstallmentDoc | null;
  /** Días de atraso de esa cuota concreta (puede diferir del máximo del préstamo). */
  nextInstallmentDaysPastDue: number;
  holder: UserDoc | null;
  /** La caché que tiene hoy el doc, para ver si el botón "recalcular" cambiaría algo. */
  cache: {
    delinquencyStatus: DelinquencyStatus;
    daysPastDue: number;
    outstandingPesos?: number;
    /** Último `update` del doc: cuándo se guardó esta caché (no cuándo se creó el préstamo). */
    updatedAt?: Date | null;
  };
}

/** Fila que sí se pudo calcular: `recalc` sin `null` y sin `error`. */
type CalculatedRow = Omit<DelinquencyRow, "recalc"> & { recalc: LoanDelinquencyResult };

export interface DelinquencyListFilter {
  /** Filtra por el estado de mora **recalculado**, no por la caché. */
  status?: DelinquencyStatus;
}

export interface DelinquencyListResult {
  rows: DelinquencyRow[];
  summary: PortfolioSummary;
  thresholds: DelinquencyThresholds;
  /** `true` si hubo más préstamos activos que `DELINQUENCY_SCAN_LIMIT`. */
  truncated: boolean;
}

export interface RecalcSummary {
  /** Préstamos leídos y recalculados. */
  evaluated: number;
  /** Préstamos cuya caché en `loans` cambió (y se escribió). */
  updated: number;
  /** Préstamos que ni se pudieron calcular: se saltan con su motivo, sin tumbar la pasada. */
  failed: Array<{ loanId: string; reason: string }>;
  /** Avisos de cuota nuevos (los repetidos no cuentan: ya estaban en la bandeja). */
  notificationsCreated: number;
  /** Avisos que ya existían y no se duplicaron. */
  notificationsSkipped: number;
  summary: PortfolioSummary;
  truncated: boolean;
}

export interface RecalcActor {
  uid: string;
  role: string;
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value !== null && "toMillis" in value) {
    return (value as { toMillis(): number }).toMillis();
  }
  return 0;
}

/**
 * Umbrales de `system_config/delinquency`.
 *
 * Si el doc falta o trae valores sin sentido, `parseDelinquencyThresholds` revienta: es
 * configuración operativa y una mora calculada con umbrales inventados es peor que una pantalla
 * en error. El seed publica `{dueSoonDays: 3, overdueDays: 1, defaultDays: 30}`.
 */
export async function readDelinquencyThresholds(db: Firestore): Promise<DelinquencyThresholds> {
  const snap = await db.collection("system_config").doc("delinquency").get();
  const value = snap.exists ? (snap.data() as SystemConfigDoc).value : undefined;
  return parseDelinquencyThresholds(value);
}

/**
 * Préstamos activos, leídos con **igualdad de un solo campo** por estado (índice automático,
 * siempre disponible) y ordenados en memoria. Un `orderBy` cruzado pediría un índice compuesto
 * que hoy no se puede desplegar (mismo motivo que `listLoansForAdmin`).
 */
async function readActiveLoans(db: Firestore): Promise<{ loans: Array<LoanDoc & { id: string }>; truncated: boolean }> {
  const base = db.collection("loans");
  const snaps = await Promise.all(
    ACTIVE_LOAN_STATUSES.map((status) => base.where("status", "==", status).limit(DELINQUENCY_SCAN_LIMIT).get()),
  );
  const loans = snaps
    .flatMap((snap) => snap.docs.map((doc) => ({ ...(doc.data() as LoanDoc), id: doc.id })))
    .sort((a, b) => {
      const diff = toMillis(b.createdAt) - toMillis(a.createdAt);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
  return { loans, truncated: snaps.some((snap) => snap.size >= DELINQUENCY_SCAN_LIMIT) };
}

/**
 * Cuotas por id determinista (`getAll`, un round trip y sin índice).
 *
 * Un préstamo sin snapshot de pricing o al que le falta una cuota **no** se recalcula: devolver un
 * saldo a medias escribiría una mora que nadie pidió. Quien lo necesita lo ve en `error`.
 */
async function readInstallments(
  db: Firestore,
  loan: { id: string; pricing?: { termInstallments?: number } },
): Promise<LoanInstallmentDoc[]> {
  const termInstallments = loan.pricing?.termInstallments;
  if (termInstallments === undefined) {
    throw conflict(
      `El préstamo ${loan.id} no tiene snapshot de pricing: no se puede recalcular su saldo (requiere migración de datos)`,
    );
  }
  const refs = Array.from({ length: termInstallments }, (_, i) =>
    db.collection("loan_installments").doc(loanInstallmentDocId(loan.id, i + 1)),
  );
  const snaps = await db.getAll(...refs);
  const faltante = snaps.find((snap) => !snap.exists);
  if (faltante !== undefined) {
    throw conflict(`El préstamo ${loan.id} no tiene la cuota ${faltante.id}: no se recalcula sobre datos incompletos`);
  }
  return snaps.map((snap) => snap.data() as LoanInstallmentDoc);
}

/** La más antigua sin pagar: la que manda en el estado de mora y la que recibe el aviso. */
function nextUnpaidInstallment(installments: readonly LoanInstallmentDoc[]): LoanInstallmentDoc | null {
  let next: LoanInstallmentDoc | null = null;
  for (const cuota of installments) {
    if (cuota.paidPesos >= cuota.totalPesos) continue;
    if (next === null || toMillis(cuota.dueDate) < toMillis(next.dueDate)) {
      next = cuota;
    }
  }
  return next;
}

/**
 * Lo que `loans` tiene guardado hoy, para contrastarlo con el recálculo.
 *
 * `updatedAt` se normaliza a `Date` porque la fila es vista de pantalla: si aquí se colara el
 * `Timestamp` crudo de Firestore, la fecha se vería solo en el cliente y no en el render.
 */
function loanCache(loan: LoanDoc): DelinquencyRow["cache"] {
  return {
    delinquencyStatus: loan.delinquencyStatus ?? DelinquencyStatus.CURRENT,
    daysPastDue: loan.daysPastDue ?? 0,
    outstandingPesos: loan.outstandingPesos,
    updatedAt: toDate(loan.updatedAt),
  };
}

function buildRow(
  loan: LoanDoc & { id: string },
  installments: LoanInstallmentDoc[],
  thresholds: DelinquencyThresholds,
  today: Date,
  holder: UserDoc | null,
): CalculatedRow {
  const nextInstallment = nextUnpaidInstallment(installments);
  return {
    loanId: loan.id,
    loanNumber: loan.loanNumber ?? loan.id,
    userId: loan.userId,
    principalPesos: loan.principalPesos,
    loanStatus: loan.status,
    recalc: recalcLoanDelinquency(installments, today, thresholds),
    nextInstallment,
    nextInstallmentDaysPastDue: nextInstallment ? daysPastDueForInstallment(nextInstallment, today) : 0,
    holder,
    cache: loanCache(loan),
  };
}

/** Titulares de las filas, en un solo `getAll` por uids únicos. */async function readHolders(
  db: Firestore,
  userIds: readonly string[],
): Promise<Map<string, UserDoc>> {
  const holders = new Map<string, UserDoc>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return holders;
  const snaps = await db.getAll(...unique.map((uid) => db.collection("users").doc(uid)));
  snaps.forEach((snap) => {
    if (snap.exists) holders.set(snap.id, snap.data() as UserDoc);
  });
  return holders;
}

/**
 * Más atrasado primero; a igual atraso, el más antiguo.
 *
 * Lo que **no** se pudo calcular va al final: sin recálculo no hay atraso con qué comparar, y
 * mezclarlo con las fechas de los demás pondría un préstamo roto en medio de la cartera.
 */
function byUrgency(a: DelinquencyRow, b: DelinquencyRow): number {
  if (a.recalc === null || b.recalc === null) {
    if (a.recalc === null && b.recalc === null) return a.loanId.localeCompare(b.loanId);
    return a.recalc === null ? 1 : -1;
  }
  const atraso = b.recalc.daysPastDue - a.recalc.daysPastDue;
  if (atraso !== 0) return atraso;
  const vencimiento =
    toMillis(a.nextInstallment?.dueDate ?? null) - toMillis(b.nextInstallment?.dueDate ?? null);
  if (vencimiento !== 0) return vencimiento;
  return a.loanId.localeCompare(b.loanId);
}

export const DELINQUENCY_FILTERS: readonly DelinquencyStatus[] = DELINQUENCY_STATUSES.filter(
  (status) => status !== DelinquencyStatus.PAID,
);

/**
 * Cartera de mora recalculada **al vuelo**, sin escribir nada.
 *
 * Devuelve también el resumen: es lo que la pantalla muestra arriba (cartera por cobrar, vencida,
 * en mora) y lo que hace que los filtros no dependan de la caché. Con `status` se filtran las
 * filas ya recalculadas, no un `where` sobre `loans`: el índice de `delinquencyStatus` tendría que
 * desplegarse y además filtraría por el dato viejo.
 */
export async function listDelinquencyForAdmin(
  deps: DelinquencyDeps,
  options: { filter?: DelinquencyListFilter; today?: Date } = {},
): Promise<DelinquencyListResult> {
  const today = options.today ?? new Date();
  const thresholds = await readDelinquencyThresholds(deps.db);
  const { loans, truncated } = await readActiveLoans(deps.db);
  const holders = await readHolders(
    deps.db,
    loans.map((loan) => loan.userId),
  );

  const rows: DelinquencyRow[] = await Promise.all(
    loans.map(async (loan): Promise<DelinquencyRow> => {
      const holder = holders.get(loan.userId) ?? null;
      try {
        const installments = await readInstallments(deps.db, loan);
        return buildRow(loan, installments, thresholds, today, holder);
      } catch (error) {
        // Un préstamo roto no puede tumbar la cartera entera: la fila lo dice y el admin lo ve.
        return {
          loanId: loan.id,
          loanNumber: loan.loanNumber ?? loan.id,
          userId: loan.userId,
          principalPesos: loan.principalPesos,
          loanStatus: loan.status,
          recalc: null,
          error: error instanceof Error ? error.message : "No se pudo calcular la mora de este préstamo",
          nextInstallment: null,
          nextInstallmentDaysPastDue: 0,
          holder,
          cache: loanCache(loan),
        };
      }
    }),
  );

  // El resumen sale solo de las filas bien calculadas: un préstamo que no se pudo leer no aporta
  // saldo ni atraso, y sumarlo a medias publicaría una cartera que no existe.
  const calculated = rows.filter((row): row is CalculatedRow => row.recalc !== null);
  const summary = summarizeDelinquency(calculated);
  const filtradas = options.filter?.status
    ? rows.filter((row) => row.recalc?.delinquencyStatus === options.filter?.status)
    : rows;

  return { rows: [...filtradas].sort(byUrgency), summary, thresholds, truncated };
}

/**
 * Recalcula un solo préstamo y **escribe** la caché. Es el botón "Recalcular" de la fila.
 *
 * 404 si el préstamo no existe; 409 si sus cuotas están incompletas (`readInstallments`).
 */
export async function recalcLoanDelinquencyNow(
  deps: DelinquencyDeps,
  loanId: string,
  now: Date = new Date(),
): Promise<{ row: DelinquencyRow; changed: boolean }> {
  const loanSnap = await deps.db.collection("loans").doc(loanId).get();
  if (!loanSnap.exists) {
    throw notFound("Préstamo no encontrado");
  }
  const loan = { ...(loanSnap.data() as LoanDoc), id: loanSnap.id };
  const thresholds = await readDelinquencyThresholds(deps.db);
  const installments = await readInstallments(deps.db, loan);
  const holders = await readHolders(deps.db, [loan.userId]);
  const row = buildRow(loan, installments, thresholds, now, holders.get(loan.userId) ?? null);

  const changed = isLoanCacheStale(loan, row.recalc);
  if (changed) {
    await deps.db.collection("loans").doc(loanId).update(loanRecalcPatch(row.recalc, loan, now));
  }
  return { row, changed };
}

function installmentBalance(installment: LoanInstallmentDoc): number {
  return installment.totalPesos - installment.paidPesos;
}

/** `not-applicable`: la cuota no está ni por vencer ni vencida, así que no hay nada que avisar. */
type ReminderOutcome = "created" | "already-exists" | "not-applicable";

/**
 * Aviso de cuota: **próxima** (vence hoy o dentro de la ventana) o **vencida**.
 *
 * Solo hay un evento por cuota, no uno por día: el doc ID lleva el número de cuota y el estado, así
 * que reavisar la cartera cada mañana no llena la bandeja de 30 copias de lo mismo. La decisión
 * sale de `dueSoonDays`/`overdueDays` de `system_config`, no de un número escrito aquí.
 */
async function notifyInstallmentReminder(
  deps: DelinquencyDeps,
  row: CalculatedRow,
  thresholds: DelinquencyThresholds,
  now: Date,
): Promise<ReminderOutcome> {
  const cuota = row.nextInstallment;
  if (cuota === null) return "not-applicable";

  // Delta con signo: `wholeDaysBetween` y no `daysPastDueForInstallment` porque este último
  // recorta en 0 y un vencimiento futuro saldría como "vence hoy" (aviso a todo el mundo).
  const delta = wholeDaysBetween(cuota.dueDate, now);
  const atraso = delta > 0 ? delta : 0;
  const diasParaVencer = delta < 0 ? -delta : 0;
  const type =
    delta > 0
      ? NotificationType.INSTALLMENT_OVERDUE
      : -delta <= thresholds.dueSoonDays
        ? NotificationType.INSTALLMENT_DUE_SOON
        : null;
  if (type === null) return "not-applicable";

  const saldo = installmentBalance(cuota);
  const vencimiento = formatDueDate(cuota.dueDate);
  const title = type === NotificationType.INSTALLMENT_OVERDUE ? "Tienes una cuota vencida" : "Tu cuota vence pronto";
  const body =
    type === NotificationType.INSTALLMENT_OVERDUE
      ? `La cuota ${cuota.installmentNumber} de ${formatPesos(saldo)} venció el ${vencimiento} (${atraso} ${
          atraso === 1 ? "día" : "días"
        } de atraso). Puedes pagarla desde "Mis préstamos".`
      : `La cuota ${cuota.installmentNumber} de ${formatPesos(saldo)} ${
          diasParaVencer === 0 ? "vence hoy" : `vence el ${vencimiento}`
        }.`;

  const { created } = await notifyUser(
    deps,
    {
      userId: row.userId,
      type,
      title,
      body,
      refKey: installmentReminderRefKey(row.loanId, cuota.installmentNumber),
      payload: {
        loanId: row.loanId,
        installmentId: loanInstallmentDocId(row.loanId, cuota.installmentNumber),
        installmentNumber: cuota.installmentNumber,
        amountPesos: saldo,
        daysPastDue: atraso,
      },
    },
    now,
    deps.notifyProviders ?? defaultProviders(deps),
  );
  return created ? "created" : "already-exists";
}

/**
 * Recálculo de **toda** la cartera activa: escribe la caché, avisa de cuotas y deja un registro de
 * auditoría por pasada.
 *
 * Idempotente por naturaleza, no por `Idempotency-Key`: dos pasadas seguidas escriben exactamente
 * los mismos valores (solo se toca lo que cambia) y los avisos repetidos no se duplican. Aun así
 * cada pasada escribe su auditoría, porque son dos operaciones reales y la segunda habría devuelto
 * el resumen anterior sin haber mirado nada.
 */
export async function recalcActivePortfolio(
  deps: DelinquencyDeps,
  actor: RecalcActor,
  now: Date = new Date(),
): Promise<RecalcSummary> {
  const thresholds = await readDelinquencyThresholds(deps.db);
  const { loans, truncated } = await readActiveLoans(deps.db);
  const holders = await readHolders(
    deps.db,
    loans.map((loan) => loan.userId),
  );

  const failed: RecalcSummary["failed"] = [];
  const calculated: Array<{ recalc: LoanDelinquencyResult }> = [];
  let updated = 0;
  let notificationsCreated = 0;
  let notificationsSkipped = 0;

  for (const loan of loans) {
    const holder = holders.get(loan.userId) ?? null;
    let row: CalculatedRow;
    try {
      row = buildRow(loan, await readInstallments(deps.db, loan), thresholds, now, holder);
    } catch (error) {
      failed.push({
        loanId: loan.id,
        reason: error instanceof Error ? error.message : "No se pudo calcular la mora de este préstamo",
      });
      continue;
    }

    calculated.push({ recalc: row.recalc });

    if (isLoanCacheStale(loan, row.recalc)) {
      await deps.db
        .collection("loans")
        .doc(loan.id)
        .update(loanRecalcPatch(row.recalc, loan, now));
      updated += 1;
    }

    const aviso = await notifyInstallmentReminder(deps, row, thresholds, now);
    if (aviso === "created") notificationsCreated += 1;
    else if (aviso === "already-exists") notificationsSkipped += 1;
  }

  const summary = summarizeDelinquency(calculated);
  await deps.db.collection("audit_logs").add({
    actorId: actor.uid,
    actorRole: actor.role,
    action: AuditAction.DELINQUENCY_RECALCULATED,
    entityType: "portfolio",
    metadata: {
      evaluated: calculated.length + failed.length,
      updated,
      notificationsCreated,
      notificationsSkipped,
      failed: failed.length,
      outstandingPesos: summary.outstandingPesos,
      overduePesos: summary.overduePesos,
      inDefaultPesos: summary.inDefaultPesos,
      byStatus: summary.byStatus,
      truncated,
    },
    createdAt: now,
  });

  return {
    evaluated: calculated.length + failed.length,
    updated,
    failed,
    notificationsCreated,
    notificationsSkipped,
    summary,
    truncated,
  };
}
