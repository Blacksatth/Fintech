import { type Firestore, type Transaction } from "firebase-admin/firestore";
import { badRequest, notFound } from "@/lib/errors";
import { stripUndefined } from "@/server/doc";
import {
  buildCreditProductDoc,
  buildInterestRateDoc,
  buildProductTierDoc,
  buildSystemConfigDoc,
  type CreditProductDoc,
  type CreditDocDate,
  type InterestRateDoc,
  type ProductTierDoc,
  type SystemConfigDoc,
} from "@/server/credit-doc";
import {
  buildPaymentChannelDoc,
  type PaymentChannelDoc,
  type PaymentChannelType,
} from "@/server/payment-doc";
import { withIdempotency } from "@/lib/idempotency";
import { AuditAction, TermFrequency } from "@/server/types";
import type { DelinquencyThresholds } from "@/server/delinquency";
import {
  CONFIG_ENTITY_TYPES,
  assertChannelStaysPublishable,
  assertProductHasActiveTier,
  assertProductKeepsActiveRate,
  assertTierAmountsAscend,
  diffConfigFields,
  interestRateDocId,
  mergeChannelMeta,
  nextRateVersion,
  parseThresholdsForWrite,
  productTierDocId,
  type ConfigFieldChange,
  type ConfigEntityType,
  type PaymentChannelMetaPatch,
} from "@/server/admin-config";

/**
 * Configuración que edita un ADMIN (PROJECT_SPEC §9: `GET/POST/PATCH /api/admin/config/**`,
 * auditada con `CONFIG_CHANGED`).
 *
 * **El servicio no escribe campos: escribe documentos validados.** Toda mutación lee el doc
 * existente, mezcla el parche y vuelve a pasarlo por el **mismo builder** con el que lo siembra
 * `npm run seed`. Así los schemas `.strict()` y sus `superRefine` (rango de cuotas, `max >= min`,
 * `effectiveTo > effectiveFrom`) siguen siendo la única fuente de la forma del documento, en vez de
 * aparecer por segunda vez en un `update()` a mano que nadie más valida.
 *
 * Configuración no es dinero: no hay `Idempotency-Key` en los parches (el doc vive en un id
 * determinista, así que repetir es last-write-wins y no duplica nada) ni notificaciones (nadie
 * espera un aviso por un cambio de umbral). Sí hay `reason` **obligatorio** y auditoría con el diff
 * campo a campo: una configuración sin explicación de por qué cambió no sirve para reconstruir por
 * qué un préstamo se creó con esa tasa.
 */

export interface AdminConfigActor {
  uid: string;
  role?: string;
}

const DELINQUENCY_CONFIG_ID = "delinquency";

/* ==================== Lectura ==================== */

export interface AdminConfigProduct extends CreditProductDoc {
  id: string;
  tiers: AdminConfigTier[];
}

export interface AdminConfigTier extends ProductTierDoc {
  id: string;
}

export interface AdminConfigRate extends InterestRateDoc {
  id: string;
}

export interface AdminConfigChannel extends PaymentChannelDoc {
  id: string;
  /** Derivado de `meta`: qué tan lejos está de recibir dinero real. */
  isDemoData: boolean;
  legalReview: string | null;
}

export interface AdminConfigSnapshot {
  products: AdminConfigProduct[];
  rates: AdminConfigRate[];
  thresholds: SystemConfigDoc | null;
  channels: AdminConfigChannel[];
}

/**
 * Lectura completa de la configuración, para la pantalla de administración.
 *
 * Sin `where` + `orderBy` combinados (trampa de F9-2: el índice compuesto no se puede desplegar sin
 * `roles/datastore.owner` y la consulta devolvía 500 en el proyecto real). Son colecciones de
 * configuración escritas por un admin: se leen enteras y se ordenan en memoria, con desempate por
 * `id` para que el orden sea estable.
 */
export async function listAdminConfig(db: Firestore): Promise<AdminConfigSnapshot> {
  const [productsSnap, tiersSnap, ratesSnap, channelsSnap, thresholdsSnap] = await Promise.all([
    db.collection("credit_products").get(),
    db.collection("product_tiers").get(),
    db.collection("interest_rates").get(),
    db.collection("payment_channels").get(),
    db.collection("system_config").doc(DELINQUENCY_CONFIG_ID).get(),
  ]);

  const tiers = tiersSnap.docs.map((doc) => ({ ...(doc.data() as ProductTierDoc), id: doc.id }));
  const byProduct = new Map<string, AdminConfigTier[]>();
  for (const tier of tiers) {
    const list = byProduct.get(tier.productCode) ?? [];
    list.push(tier);
    byProduct.set(tier.productCode, list);
  }
  for (const list of byProduct.values()) {
    list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }

  const products = productsSnap.docs
    .map((doc) => ({
      ...(doc.data() as CreditProductDoc),
      id: doc.id,
      tiers: byProduct.get(doc.id) ?? [],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const rates = ratesSnap.docs
    .map((doc) => ({ ...(doc.data() as InterestRateDoc), id: doc.id }))
    .sort(
      (a, b) => a.productType.localeCompare(b.productType) || b.version - a.version || a.id.localeCompare(b.id),
    );

  const channels = channelsSnap.docs
    .map((doc) => toAdminChannel({ ...(doc.data() as PaymentChannelDoc), id: doc.id }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    products,
    rates,
    thresholds: thresholdsSnap.exists ? (thresholdsSnap.data() as SystemConfigDoc) : null,
    channels,
  };
}

function toAdminChannel(channel: PaymentChannelDoc & { id: string }): AdminConfigChannel {
  const legalReview = channel.meta?.["legalReview"];
  return {
    ...channel,
    isDemoData: channel.meta?.["demo"] === true,
    legalReview: typeof legalReview === "string" ? legalReview : null,
  };
}

/* ==================== Utilería de escritura ==================== */

/**
 * Escritura de configuración + auditoría en la **misma transacción**.
 *
 * La lectura del doc previo es la que arma el `before` del diff y la que alimenta las invariantes
 * entre documentos. Y que la auditoría viaje en la transacción no es decorativo: si el audit se
 * escribiera después, un fallo de red entre el `set` y el `add` dejaría una configuración cambiada
 * sin rastro de quién la cambió — que es exactamente el escenario que `audit_logs` existe para
 * rastrear.
 */
async function writeConfig(
  db: Firestore,
  tx: Transaction,
  params: {
    entityType: ConfigEntityType;
    entityId: string;
    actor: AdminConfigActor;
    reason: string;
    changes: ConfigFieldChange[];
    now: Date;
  },
): Promise<void> {
  if (params.changes.length === 0) {
    // Guardar sin cambiar nada no es un cambio: sin fila de auditoría el "no pasó nada" sería
    // indistinguible de un cambio cuyo diff se perdió, que es justo lo que la auditoría no puede.
    throw badRequest("El cambio no modifica ningún valor. Edita algún campo antes de guardar.");
  }
  tx.set(db.collection("audit_logs").doc(), {
    actorId: params.actor.uid,
    actorRole: params.actor.role ?? "ADMIN",
    action: AuditAction.CONFIG_CHANGED,
    entityType: params.entityType,
    entityId: params.entityId,
    metadata: { reason: params.reason, changes: params.changes },
    createdAt: params.now,
  });
}

async function readProductIn(db: Firestore, tx: Transaction, productCode: string): Promise<CreditProductDoc> {
  const snap = await tx.get(db.collection("credit_products").doc(productCode));
  if (!snap.exists) {
    throw notFound(`Producto de crédito no encontrado: ${productCode}`);
  }
  return snap.data() as CreditProductDoc;
}

/**
 * Lectura con el ID a la vista.
 *
 * Importa más de lo que parece: las validaciones cruzadas (escalera ascendente, producto con tier
 * activo) tienen que distinguir *el tier que se está editando* del resto. Comparar por identidad de
 * objeto (`tier === current`) funciona contra un mock en memoria y **falla contra Firestore**, donde
 * cada lectura devuelve objetos nuevos: el candidato nunca se sustituiría y se validaría el estado
 * viejo, dejando pasar el cambio que se quería rechazar.
 */
interface DocWithId<T> {
  id: string;
  doc: T;
}

async function readTiersIn(
  db: Firestore,
  tx: Transaction,
  productCode: string,
): Promise<DocWithId<ProductTierDoc>[]> {
  const snap = await tx.get(db.collection("product_tiers").where("productCode", "==", productCode));
  return snap.docs.map((doc) => ({ id: doc.id, doc: doc.data() as ProductTierDoc }));
}

async function readRatesIn(
  db: Firestore,
  tx: Transaction,
  productType: string,
): Promise<DocWithId<InterestRateDoc>[]> {
  const snap = await tx.get(db.collection("interest_rates").where("productType", "==", productType));
  return snap.docs.map((doc) => ({ id: doc.id, doc: doc.data() as InterestRateDoc }));
}

/** Sustituye el doc de `targetId` por su versión nueva; el resto queda intacto. */
function replaceDoc<T>(entries: DocWithId<T>[], targetId: string, next: T): T[] {
  return entries.map((entry) => (entry.id === targetId ? next : entry.doc));
}

/**
 * Devuelve al candidato su `createdAt` original.
 *
 * Los builders son de **alta**: todos fijan `createdAt: now` porque su único uso previsto era el
 * seed. Al reescribir un doc existente con el mismo builder, cada parche reseteaba la fecha de
 * creación al momento de la edición — "creado el" mentía sobre cuándo entró esa configuración, y el
 * diff de auditoría tampoco lo notaba porque `createdAt` no está en las listas de campos
 * auditables. Por eso se restaura aquí y no "se pasa el `createdAt` al builder": los builders no lo
 * aceptan, y ampliar su firma para un caso de uso sería peor.
 */
function keepOriginalCreatedAt<T extends { createdAt: CreditDocDate }>(candidate: T, current: T): T {
  return { ...candidate, createdAt: current.createdAt };
}

/* ==================== Producto ==================== */

export interface UpdateCreditProductInput {
  productCode: string;
  name?: string;
  termFrequency?: TermFrequency;
  termInstallments?: number;
  minTermInstallments?: number;
  maxTermInstallments?: number;
  effectiveFeeBps?: number;
  isActive?: boolean;
  reason: string;
}

/**
 * Campos editables de `credit_products`. `currency` y `id` quedan fuera: la moneda es COP por
 * schema y el código es el doc id, que aparece en `loans.productCode` y en las application's
 * `productId`.
 */
const PRODUCT_FIELDS = [
  "name",
  "termFrequency",
  "termInstallments",
  "minTermInstallments",
  "maxTermInstallments",
  "effectiveFeeBps",
  "isActive",
] as const;

export async function updateCreditProduct(
  db: Firestore,
  actor: AdminConfigActor,
  input: UpdateCreditProductInput,
  now: Date,
): Promise<CreditProductDoc> {
  return db.runTransaction(async (tx) => {
    const current = await readProductIn(db, tx, input.productCode);
    const candidate = keepOriginalCreatedAt(
      buildCreditProductDoc(
        {
          name: input.name ?? current.name,
          currency: current.currency,
          termInstallments: input.termInstallments ?? current.termInstallments,
          termFrequency: input.termFrequency ?? current.termFrequency,
          minTermInstallments: input.minTermInstallments ?? current.minTermInstallments,
          maxTermInstallments: input.maxTermInstallments ?? current.maxTermInstallments,
          effectiveFeeBps: input.effectiveFeeBps ?? current.effectiveFeeBps,
          isActive: input.isActive ?? current.isActive,
        },
        now,
      ),
      current,
    );

    // Un producto activo sin tier activo no se puede solicitar; desactivar el producto es la
    // salida, y por eso se comprueba el estado **resultante**.
    await assertProductHasActiveTier(candidate, (await readTiersIn(db, tx, input.productCode)).map((e) => e.doc));

    const changes = diffConfigFields(
      current as unknown as Record<string, unknown>,
      candidate as unknown as Record<string, unknown>,
      PRODUCT_FIELDS,
    );
    await writeConfig(db, tx, {
      entityType: CONFIG_ENTITY_TYPES.product,
      entityId: input.productCode,
      actor,
      reason: input.reason,
      changes,
      now,
    });
    await tx.set(db.collection("credit_products").doc(input.productCode), stripUndefined(candidate));
    return candidate;
  });
}

/* ==================== Tiers ==================== */

export interface CreateProductTierInput {
  productCode: string;
  position: number;
  amountPesos: number;
  minScore?: number;
  reason: string;
}

export interface UpdateProductTierInput {
  tierId: string;
  amountPesos?: number;
  minScore?: number;
  isActive?: boolean;
  reason: string;
}

const TIER_FIELDS = ["amountPesos", "minScore", "isActive"] as const;

/**
 * Alta de un rung de la escalera de montos.
 *
 * El doc ID es `{productCode}_{position}` (§8.1), determinista: escribir en una posición ocupada
 * **pisa** el tier anterior, y si estaba desactivado se perdía sin dejar rastro. Por eso el alta
 * lleva `Idempotency-Key` (a diferencia de los parches): el id se deriva de la posición, así que
 * la repetición natural de un doble clic escribiría sobre el doc recién creado. Con la clave, el
 * segundo intento es un replay y devuelve el mismo tier.
 */
export async function createProductTier(
  db: Firestore,
  actor: AdminConfigActor,
  input: CreateProductTierInput,
  options: { idempotencyKey: string },
  now: Date,
): Promise<{ id: string; doc: ProductTierDoc; replayed: boolean }> {
  const productCode = input.productCode.trim();
  if (productCode.length === 0) throw badRequest("El producto del tier no puede estar vacío");

  const outcome = await withIdempotency(db, {
    scope: "config.tier.create",
    key: options.idempotencyKey,
    entityType: CONFIG_ENTITY_TYPES.tier,
    run: async (tx) => {
      // El tier tiene que pertenecer a un producto que existe: crear el rung de un código
      // inexistente deja una escalera que ningún flujo va a leer.
      await readProductIn(db, tx, productCode);
      const tierId = productTierDocId(productCode, input.position);
      const ref = db.collection("product_tiers").doc(tierId);

      const existing = await tx.get(ref);
      if (existing.exists) {
        throw badRequest(
          `Ya existe un tier en la posición ${input.position} de ${productCode} (${tierId}). ` +
            `Si el que hay está mal, edítalo; no se puede reemplazar por la misma posición`,
        );
      }

      const doc = buildProductTierDoc(
        {
          productCode,
          position: input.position,
          amountPesos: input.amountPesos,
          minScore: input.minScore,
          isActive: true,
        },
        now,
      );

      assertTierAmountsAscend([...(await readTiersIn(db, tx, productCode)).map((e) => e.doc), doc]);

      await writeConfig(db, tx, {
        entityType: CONFIG_ENTITY_TYPES.tier,
        entityId: tierId,
        actor,
        reason: input.reason,
        changes: [
          {
            field: "created",
            before: null,
            after: { position: doc.position, amountPesos: doc.amountPesos, isActive: true },
          },
        ],
        now,
      });
      await tx.set(ref, stripUndefined(doc));
      return { entityId: tierId };
    },
  });

  const id = outcome.entityId!;
  if (outcome.replayed) {
    const snap = await db.collection("product_tiers").doc(id).get();
    if (!snap.exists) throw notFound(`El tier ${id} ya no existe: se creó y luego se eliminó`);
    return { id, doc: snap.data() as ProductTierDoc, replayed: true };
  }
  return { id, doc: await readTierById(db, id), replayed: false };
}

async function readTierById(db: Firestore, id: string): Promise<ProductTierDoc> {
  const snap = await db.collection("product_tiers").doc(id).get();
  if (!snap.exists) throw notFound(`El tier ${id} no existe`);
  return snap.data() as ProductTierDoc;
}

export async function updateProductTier(
  db: Firestore,
  actor: AdminConfigActor,
  input: UpdateProductTierInput,
  now: Date,
): Promise<{ id: string; doc: ProductTierDoc }> {
  return db.runTransaction(async (tx) => {
    const ref = db.collection("product_tiers").doc(input.tierId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw notFound(`Tier no encontrado: ${input.tierId}`);
    }
    const current = snap.data() as ProductTierDoc;
    // `position` y `productCode` no se editan: son la identidad del rung y el prefijo del doc ID.
    const doc = keepOriginalCreatedAt(
      buildProductTierDoc(
        {
          productCode: current.productCode,
          position: current.position,
          amountPesos: input.amountPesos ?? current.amountPesos,
          minScore: input.minScore ?? current.minScore,
          isActive: input.isActive ?? current.isActive,
        },
        now,
      ),
      current,
    );

    const tiers = await readTiersIn(db, tx, current.productCode);
    const product = await readProductIn(db, tx, current.productCode);
    const candidate = replaceDoc(tiers, input.tierId, doc);
    assertTierAmountsAscend(candidate);
    assertProductHasActiveTier(product, candidate);

    const changes = diffConfigFields(
      current as unknown as Record<string, unknown>,
      doc as unknown as Record<string, unknown>,
      TIER_FIELDS,
    );
    await writeConfig(db, tx, {
      entityType: CONFIG_ENTITY_TYPES.tier,
      entityId: input.tierId,
      actor,
      reason: input.reason,
      changes,
      now,
    });
    await tx.set(ref, stripUndefined(doc));
    return { id: input.tierId, doc };
  });
}

/* ==================== Tasas ==================== */

export interface CreateInterestRateInput {
  productType: string;
  annualRateBps: number;
  maximumRateBps?: number;
  /** `YYYY-MM-DD`. Se guarda a medianoche UTC: la tasa empieza ese día, no "ahora". */
  effectiveFrom: string;
  source: string;
  reason: string;
}

/**
 * Alta de una **versión** de tasa (`interest_rates/{productType}_v{n}`), nunca edición de una
 * existente.
 *
 * `resolvePricing` toma la tasa activa y vigente de mayor versión, así que la nueva manda sobre
 * las anteriores sin tocar ninguna y cada préstamo sigue teniendo en `loans.pricing` la tasa que
 * aceptó. Editar la vigente en su lugar borraría el registro de lo que valía antes, que es
 * justamente lo que hace auditable un préstamo.
 *
 * La versión se reserva leyendo el máximo **dentro de la transacción** y el doc ID es
 * determinista: dos altas simultáneas chocan en la misma ruta y el perdedo reintenta con la
 * versión ya tomada (el mismo patrón que el consecutivo de `PAY-{año}-{n}`).
 */
export async function createInterestRateVersion(
  db: Firestore,
  actor: AdminConfigActor,
  input: CreateInterestRateInput,
  options: { idempotencyKey: string },
  now: Date,
): Promise<{ id: string; doc: InterestRateDoc; replayed: boolean }> {
  const productCode = input.productType.trim();
  if (productCode.length === 0) throw badRequest("El producto de la tasa no puede estar vacío");

  const effectiveFrom = parseEffectiveFrom(input.effectiveFrom);

  const outcome = await withIdempotency(db, {
    scope: "config.rate.create",
    key: options.idempotencyKey,
    entityType: CONFIG_ENTITY_TYPES.rate,
    run: async (tx) => {
      // La tasa solo existe para un producto que existe: una versión colgada de un código
      // huérfano no la lee ningún flujo y sí aparece en los listados de configuración.
      await readProductIn(db, tx, productCode);
      const rates = (await readRatesIn(db, tx, productCode)).map((entry) => entry.doc);
      const version = nextRateVersion(rates);
      const id = interestRateDocId(productCode, version);
      const doc = buildInterestRateDoc(
        {
          productType: productCode,
          annualRateBps: input.annualRateBps,
          maximumRateBps: input.maximumRateBps,
          effectiveFrom,
          source: input.source,
          version,
          isActive: true,
        },
        now,
      );

      await writeConfig(db, tx, {
        entityType: CONFIG_ENTITY_TYPES.rate,
        entityId: id,
        actor,
        reason: input.reason,
        changes: [
          { field: "created", before: null, after: { version, annualRateBps: doc.annualRateBps, isActive: true } },
        ],
        now,
      });
      await tx.set(db.collection("interest_rates").doc(id), stripUndefined(doc));
      return { entityId: id };
    },
  });

  if (outcome.replayed) {
    // El replay no ejecuta `run`: se reconstruye la respuesta leyendo la entidad, como el resto
    // del sistema (`withIdempotency` no guarda resultados).
    return { ...(await readRateById(db, outcome.entityId!)), replayed: true };
  }

  return { ...(await readRateById(db, outcome.entityId!)), replayed: false };
}

/**
 * Relee la tasa recién escrita. Hace falta porque el builder devuelve `CreditDocDate`
 * (`Date | {toMillis}`) mientras Firestore guarda un `Timestamp`: lo que se devuelve al route tiene
 * que ser exactamente el doc que quedó, no el candidato en memoria.
 */
async function readRateById(
  db: Firestore,
  id: string,
): Promise<{ id: string; doc: InterestRateDoc }> {
  const snap = await db.collection("interest_rates").doc(id).get();
  if (!snap.exists) {
    throw notFound(`La tasa ${id} no existe`);
  }
  return { id, doc: snap.data() as InterestRateDoc };
}

/**
 * `YYYY-MM-DD` → medianoche UTC del día, no del instante.
 *
 * La fecha se guarda a medianoche UTC porque la tasa empieza **ese día**: guardar "ahora" haría que
 * una versión creada a las 18:00 rigiera retroactivamente unas horas.
 *
 * Se valida el calendario con round-trip porque `new Date("2026-02-31")` no da `NaN`: normaliza a
 * 3 de marzo y aceptaría una fecha que no existe. Un 29 de febrero de un año no bisiesto es el
 * mismo caso, y es el error que un admin escribiría sin darse cuenta.
 */
export function parseEffectiveFrom(value: string): Date {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw badRequest("La fecha de vigencia debe tener el formato AAAA-MM-DD");
  }
  const date = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`La fecha ${trimmed} no existe`);
  }
  // `toISOString()` devuelve el día que JavaScript realmente parseó: si no coincide con el escrito,
  // la fecha se corrió (31 de febrero → 3 de marzo).
  if (date.toISOString().slice(0, 10) !== trimmed) {
    throw badRequest(`La fecha ${trimmed} no existe en el calendario`);
  }
  return date;
}

export interface SetInterestRateActiveInput {
  rateId: string;
  isActive: boolean;
  reason: string;
}

/**
 * Lo único editable de una tasa es si está activa. Los importes de una versión publicada no se
 * tocan: cambiarlos en el sitio reescribiría la historia de los préstamos que se crearon con ella.
 */
export async function setInterestRateActive(
  db: Firestore,
  actor: AdminConfigActor,
  input: SetInterestRateActiveInput,
  now: Date,
): Promise<{ id: string; doc: InterestRateDoc }> {
  return db.runTransaction(async (tx) => {
    const ref = db.collection("interest_rates").doc(input.rateId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw notFound(`Tasa no encontrada: ${input.rateId}`);
    }
    const current = snap.data() as InterestRateDoc;
    const product = await readProductIn(db, tx, current.productType);
    const rates = await readRatesIn(db, tx, current.productType);

    // Se valida el estado **resultante**: un producto activo no puede quedarse sin tasa activa, así
    // que desactivar la única versión vigente tiene que rechazarse, no aceptarse y dejar el producto
    // vendiendo a tasa 0.
    assertProductKeepsActiveRate(
      product,
      replaceDoc(rates, input.rateId, { ...current, isActive: input.isActive }),
    );

    const doc = keepOriginalCreatedAt(
      buildInterestRateDoc(
        {
          productType: current.productType,
          annualRateBps: current.annualRateBps,
          maximumRateBps: current.maximumRateBps,
          effectiveFrom: current.effectiveFrom,
          effectiveTo: current.effectiveTo,
          source: current.source,
          version: current.version,
          isActive: input.isActive,
        },
        now,
      ),
      current,
    );

    await writeConfig(db, tx, {
      entityType: CONFIG_ENTITY_TYPES.rate,
      entityId: input.rateId,
      actor,
      reason: input.reason,
      changes: diffConfigFields(
        current as unknown as Record<string, unknown>,
        doc as unknown as Record<string, unknown>,
        ["isActive"],
      ),
      now,
    });
    await tx.set(ref, stripUndefined(doc));
    return { id: input.rateId, doc };
  });
}

/* ==================== Umbrales de mora ==================== */

export interface UpdateThresholdsInput {
  dueSoonDays: number;
  overdueDays: number;
  defaultDays: number;
  reason: string;
}

const THRESHOLD_FIELDS = ["dueSoonDays", "overdueDays", "defaultDays"] as const;

export async function updateDelinquencyThresholds(
  db: Firestore,
  actor: AdminConfigActor,
  input: UpdateThresholdsInput,
  now: Date,
): Promise<DelinquencyThresholds> {
  // Valida con el parser del motor de mora (`parseThresholdsForWrite`): lo que se puede guardar es
  // exactamente lo que `recalcLoanDelinquency` va a saber leer.
  const thresholds = parseThresholdsForWrite({
    dueSoonDays: input.dueSoonDays,
    overdueDays: input.overdueDays,
    defaultDays: input.defaultDays,
  });

  return db.runTransaction(async (tx) => {
    const ref = db.collection("system_config").doc(DELINQUENCY_CONFIG_ID);
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data() as SystemConfigDoc) : null;

    await writeConfig(db, tx, {
      entityType: CONFIG_ENTITY_TYPES.thresholds,
      entityId: DELINQUENCY_CONFIG_ID,
      actor,
      reason: input.reason,
      changes: diffConfigFields(
        (current?.value ?? {}) as Record<string, unknown>,
        { ...thresholds } as Record<string, unknown>,
        THRESHOLD_FIELDS,
      ),
      now,
    });
    await tx.set(
      ref,
      stripUndefined(
        buildSystemConfigDoc({ value: { ...thresholds }, updatedBy: actor.uid }, now),
      ),
    );
    return thresholds;
  });
}

/* ==================== Canales de pago ==================== */

export interface UpdatePaymentChannelInput extends PaymentChannelMetaPatch {
  channelId: PaymentChannelType;
  name?: string;
  instructionsText?: string;
  isActive?: boolean;
  reason: string;
}

const CHANNEL_FIELDS = ["name", "instructionsText", "isActive", "meta"] as const;

/**
 * Edición de un canal de pago (`payment_channels/{type}`).
 *
 * `type` no se edita porque **es** el doc ID: cambiarlo no renombraría nada, crearía otro canal y
 * dejaría los pagos ya registrados apuntando al anterior.
 */
export async function updatePaymentChannel(
  db: Firestore,
  actor: AdminConfigActor,
  input: UpdatePaymentChannelInput,
  now: Date,
): Promise<PaymentChannelDoc> {
  return db.runTransaction(async (tx) => {
    const ref = db.collection("payment_channels").doc(input.channelId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw notFound(`Canal de pago no encontrado: ${input.channelId}`);
    }
    const current = snap.data() as PaymentChannelDoc;
    if (current.type !== input.channelId) {
      throw badRequest(`El canal ${input.channelId} no puede cambiar de tipo: el tipo es su identificador`);
    }

    const name = input.name ?? current.name;
    const isActive = input.isActive ?? current.isActive;
    assertChannelStaysPublishable(name, isActive);

    const meta = mergeChannelMeta(current.meta ?? {}, {
      publicMeta: input.publicMeta,
      dataReplaced: input.dataReplaced,
    });
    const doc = keepOriginalCreatedAt(
      buildPaymentChannelDoc(
        {
          name,
          type: current.type,
          instructionsText: input.instructionsText ?? current.instructionsText,
          meta,
          isActive,
        },
        now,
      ),
      current,
    );

    await writeConfig(db, tx, {
      entityType: CONFIG_ENTITY_TYPES.channel,
      entityId: input.channelId,
      actor,
      reason: input.reason,
      changes: diffConfigFields(
        current as unknown as Record<string, unknown>,
        doc as unknown as Record<string, unknown>,
        CHANNEL_FIELDS,
      ),
      now,
    });
    await tx.set(ref, stripUndefined(doc));
    return doc;
  });
}
