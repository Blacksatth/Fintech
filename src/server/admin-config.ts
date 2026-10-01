import { badRequest, conflict } from "@/lib/errors";
import type { CreditProductDoc, InterestRateDoc, ProductTierDoc } from "./credit-doc";
import type { CreditDocDate } from "./credit-doc";
import { parseDelinquencyThresholds, type DelinquencyThresholds } from "./delinquency";
import {
  PAYMENT_CHANNEL_DEMO_META_KEY,
  PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO,
  PAYMENT_CHANNEL_LEGAL_REVIEW_REPLACED,
  isPublicPaymentChannelMetaKey,
  type PaymentChannelPublicMetaKey,
} from "./payment-doc";

/**
 * Reglas de la configuración que edita un ADMIN (PROJECT_SPEC §6.1, §7.3, §9, §13, §15 — F13-2b).
 *
 * Dominio puro: sin Firebase ni Next, como el resto de `src/server/`. Aquí viven las invariantes
 * **entre documentos** que un schema de zod no puede ver porque dependen del resto de la
 * configuración: que la escalera de montos suba, que el producto no se quede sin tasa vigente, que
 * el canal no deje de publicar los datos de la cuenta.
 *
 * Cada invariante responde a una pregunta: "¿qué se rompe en silencio si el admin guarda esto?".
 * Un schema puede decir "el monto es un entero positivo"; no puede decir "si este es el último tier
 * activo, el producto queda sin nada que ofrecer y el cliente ve un error en vez de un mensaje".
 *
 * Los errores usan `AppError` (`badRequest` 400 / `conflict` 409) y no `RangeError` a propósito:
 * estas validaciones son alcanzables desde HTTP (el body de la ruta solo valida la forma), y un
 * `RangeError` se traducía a 500, que le dice al admin "se rompió el servidor" cuando lo que pasó
 * es que su formulario era incoherente.
 */

/** `entityType` que va en `audit_logs` para cada sección de configuración. */
export const CONFIG_ENTITY_TYPES = {
  product: "credit_product",
  tier: "product_tier",
  rate: "interest_rate",
  thresholds: "system_config",
  channel: "payment_channel",
} as const;
export type ConfigEntityType = (typeof CONFIG_ENTITY_TYPES)[keyof typeof CONFIG_ENTITY_TYPES];

export function toMillis(value: CreditDocDate): number {
  if (value instanceof Date) return value.getTime();
  return value.toMillis();
}

/* ==================== Escalera de tiers ==================== */

/**
 * Doc ID de un tier: `${productCode}_${position}` (PROJECT_SPEC §8.1).
 *
 * Es determinista a propósito —la escalera se lee y se escribe por id— y por eso crear un tier en
 * una posición que ya existe **no** agrega uno: pisa el anterior, incluido uno desactivado. El
 * servicio lo comprueba antes de escribir.
 *
 * El código se valida aquí y no solo en el servicio porque el `productCode` de la URL llega sin
 * comprobar: un código vacío produciría el id `_1`, un documento real al que nadie apunta y que
 * ensuciaría la escalera de un producto inexistente.
 */
export function productTierDocId(productCode: string, position: number): string {
  return `${assertProductCode(productCode)}_${position}`;
}

export function interestRateDocId(productType: string, version: number): string {
  return `${assertProductCode(productType)}_v${version}`;
}

/** Código de producto no vacío, sin espacios en los bordes: es la mitad de un doc ID. */
function assertProductCode(productCode: string): string {
  const trimmed = productCode.trim();
  if (trimmed.length === 0) {
    throw badRequest("El código de producto no puede estar vacío");
  }
  return trimmed;
}

/**
 * La escalera de un producto debe subir de verdad: más historial → más monto.
 *
 * `findEligibleTier` (PROJECT_SPEC §6.1) elige el tier **por `position`** y `capTierByCreditLimit`
 * baja al **mayor monto que quepa**. Si el monto no crece con la posición, las dos reglas se
 * contradicen sin que nada falle: el tercer préstamo del cliente podría darle menos dinero que el
 * segundo, y el cap por límite bajaría a un rung de monto mayor. No es un crash, es la política de
 * crédito al revés, que es peor.
 *
 * Solo mira los tiers **activos**: uno desactivado no participa de ninguna de las dos reglas.
 */
export function assertTierAmountsAscend(tiers: readonly ProductTierDoc[]): void {
  const active = tiers
    .filter((tier) => tier.isActive)
    .slice()
    .sort((a, b) => a.position - b.position);

  for (let i = 1; i < active.length; i += 1) {
    const previous = active[i - 1]!;
    const current = active[i]!;
    if (current.amountPesos <= previous.amountPesos) {
      throw conflict(
        `El monto del tier ${current.position} (${current.amountPesos} pesos) no es mayor que el del ` +
          `tier ${previous.position} (${previous.amountPesos} pesos): la escalera de montos debe subir ` +
          `con la posición`,
      );
    }
  }
}

/**
 * Un producto activo sin ningún tier activo no se puede solicitar: `findEligibleTier` devuelve
 * `canApply: false` con "No hay tiers activos para este producto" y el cliente ve un error en
 * `/solicitar` en lugar de un mensaje que lo explique.
 *
 * Un producto **inactivo** sí puede quedarse sin tiers: eso es cerrarlo, y es una decisión
 * legítima. Por eso la comprobación mira el `isActive` del producto, no solo el conteo.
 */
export function assertProductHasActiveTier(
  product: Pick<CreditProductDoc, "isActive">,
  tiers: readonly ProductTierDoc[],
): void {
  if (!product.isActive) return;
  if (tiers.some((tier) => tier.isActive)) return;
  throw conflict(
    "El producto quedaría sin ningún tier activo y ningún cliente podría solicitar un préstamo. " +
      "Desactiva primero el producto si lo que quieres es cerrarlo",
  );
}

/* ==================== Umbrales de mora ==================== */

/**
 * Los umbrales de `system_config/delinquency` se validan con el **mismo** parser que los lee el
 * motor de mora. Es la razón de que esta función exista: el día que `dueSoonDays` o `defaultDays`
 * se puedan editar desde la pantalla, la única forma honesta de aceptar un valor es pasar por el
 * lector que los va a usar. Si se aceptara un rango más laxo, la pantalla podría guardar una
 * configuración que el motor rechaza en el recálculo, y el admin vería el error un día después.
 *
 * Encima del parser se añade **una** regla que el parser no tiene, y no por capricho:
 * `dueSoonDays < overdueDays`.
 *
 * Con `dueSoonDays >= overdueDays` el motor clasifica mal sin fallar. En `recalcLoanDelinquency` una
 * cuota vencida hace `delta > 0`, así que cae en la rama `-delta <= dueSoonDays` y sale `DUE_SOON`:
 * un préstamo ya vencido se anunciaría como "vence pronto". El parser lo permite porque solo valida
 * rangos, no la relación entre ellos; esta función es el punto donde esa relación se vuelve
 * exigible porque alguien la está escribiendo a mano.
 *
 * En cambio `defaultDays >= overdueDays` se deja como el motor lo define (`>=`), porque exigir
 * `>` proibiría una configuración legítima: sin ventana de solo "vencido", el préstamo salta de
 * `CURRENT` a `DEFAULT` el día del atraso. Ser más estricto que el motor aquí no evita ningún error
 * de clasificación, solo una decisión de política que es de quien configura.
 */
export function parseThresholdsForWrite(value: unknown): DelinquencyThresholds {
  let thresholds: DelinquencyThresholds;
  try {
    thresholds = parseDelinquencyThresholds(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "valores inválidos";
    throw badRequest(`Umbrales de mora inválidos: ${reason}`);
  }
  if (thresholds.dueSoonDays >= thresholds.overdueDays) {
    throw badRequest(
      `dueSoonDays (${thresholds.dueSoonDays}) debe ser menor que overdueDays (${thresholds.overdueDays}): ` +
        `si no, un préstamo ya vencido se clasificaría como "vence pronto"`,
    );
  }
  return thresholds;
}

/* ==================== Tasas de interés ==================== */

/**
 * Versión siguiente de una tasa: `máximo existente + 1`.
 *
 * `resolvePricing` elige la tasa activa y vigente de **mayor versión**, así que una versión nueva
 * manda sobre las anteriores sin tocar ninguna. Por eso las tasas no se editan: se versionan, y el
 * doc anterior queda como el registro de lo que el cliente aceptó en su momento.
 */
export function nextRateVersion(existing: readonly InterestRateDoc[]): number {
  return existing.reduce((max, rate) => Math.max(max, rate.version), 0) + 1;
}

/**
 * Un producto activo necesita al menos una tasa **activa**: sin ella `resolvePricing` falla con
 * 409 "No hay tasa de interés activa y vigente" en el momento de crear el préstamo, que es cuando
 * el cliente está esperando la respuesta de su solicitud. Desactivar la última tasa activa es
 * cerrar el crédito sin decirlo, así que se rechaza aquí, donde todavía se puede explicar.
 */
export function assertProductKeepsActiveRate(
  product: Pick<CreditProductDoc, "isActive">,
  rates: readonly InterestRateDoc[],
): void {
  if (!product.isActive) return;
  if (rates.some((rate) => rate.isActive)) return;
  throw conflict(
    "El producto se quedaría sin ninguna tasa activa y no se podría crear ningún préstamo nuevo. " +
      "Activa otra versión de la tasa o desactiva primero el producto",
  );
}

/* ==================== Canales de pago ==================== */

export interface PaymentChannelMetaPatch {
  publicMeta?: Partial<Record<PaymentChannelPublicMetaKey, string>>;
  /** El admin afirma que ya_METÓ_ los datos reales (o que vuelve a los de demostración). */
  dataReplaced?: boolean;
}

/**
 * Fusiona el parche de `meta` sobre el `meta` existente.
 *
 * Dos reglas, y las dos importan:
 *
 * 1. **Solo se escriben claves de la allowlist pública.** `meta` es escritura de admin y hoy lleva
 *    marcadores que no son datos de la cuenta (`demo`, `legalReview`, `displayOrder`). Si la
 *    pantalla pudiera escribir cualquier clave, un refactor podría pisarlos; y si reemplazara el
 *    objeto entero, guardar una cuenta nueva borraría el aviso legal sin que nadie lo pidiera.
 *    Las claves que no se tocan se **conservan**.
 * 2. **`dataReplaced` es una afirmación explícita del admin, en las dos direcciones.** Poner `true`
 *    borra `demo` y deja `legalReview = DEMO_REPLACED_PENDING_LEGAL_REVIEW`, que dice exactamente
 *    lo que pasó (ya no son datos inventados, legal sigue sin revisar) y nada más. Poner `false`
 *    vuelve a marcar el canal como demostración. Omitirlo no cambia los marcadores: guardar la cuenta
 *    nueva no debe bastar para borrar la advertencia.
 */
export function mergeChannelMeta(
  current: Record<string, unknown>,
  patch: PaymentChannelMetaPatch,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };

  const publicMeta = patch.publicMeta;
  if (publicMeta) {
    for (const [key, value] of Object.entries(publicMeta)) {
      // La allowlist se vuelve a comprobar en el servicio (que recibe datos de HTTP) y aquí, para
      // que el dominio no dependa de que el llamador ya haya filtrado.
      if (!isPublicPaymentChannelMetaKey(key)) continue;
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed.length === 0) {
        // Cadena vacía = el admin quitó el dato. Se borra la clave en vez de guardar "".
        delete merged[key];
      } else {
        merged[key] = trimmed;
      }
    }
  }

  if (patch.dataReplaced === true) {
    delete merged[PAYMENT_CHANNEL_DEMO_META_KEY];
    merged["legalReview"] = PAYMENT_CHANNEL_LEGAL_REVIEW_REPLACED;
  } else if (patch.dataReplaced === false) {
    merged[PAYMENT_CHANNEL_DEMO_META_KEY] = true;
    merged["legalReview"] = PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO;
  }

  return merged;
}

/** Un canal desactivado deja de ofrecerse; eso es decisión del admin, no un error. */
export function assertChannelStaysPublishable(name: string, isActive: boolean): void {
  if (!isActive) return;
  if (name.trim().length < 2) {
    throw badRequest("El nombre del canal debe tener al menos 2 caracteres para poder publicarse");
  }
}

/* ==================== Auditoría del cambio ==================== */

export interface ConfigFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * Diff campo a campo para `audit_logs.metadata.changes`.
 *
 * Guardar el doc entero antes y después llenaría la auditoría de ruido (id, `createdAt`, todo lo que
 * no cambió) y escondería lo único que sirve: qué se movió. Solo se listan los campos que de
 * verdad cambiaron, y `undefined` y "ausente" se comparan como lo mismo —Firestore borra las claves
 * con `undefined`, así que un doc leído nunca las tiene y sin esta normalización el diff reportaría
 * cambios que no hubo.
 */
export function diffConfigFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): ConfigFieldChange[] {
  const changes: ConfigFieldChange[] = [];
  for (const field of fields) {
    const previous = before[field] ?? null;
    const next = after[field] ?? null;
    if (!Object.is(previous, next)) {
      changes.push({ field, before: previous, after: next });
    }
  }
  return changes;
}
