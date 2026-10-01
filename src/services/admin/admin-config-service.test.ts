import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  createInterestRateVersion,
  createProductTier,
  listAdminConfig,
  parseEffectiveFrom,
  setInterestRateActive,
  updateCreditProduct,
  updateDelinquencyThresholds,
  updatePaymentChannel,
  updateProductTier,
  type AdminConfigActor,
} from "./admin-config-service";
import { AppError, ErrorCode } from "@/lib/errors";
import { AuditAction, TermFrequency } from "@/server/types";
import {
  buildCreditProductDoc,
  buildInterestRateDoc,
  buildProductTierDoc,
  Currency,
} from "@/server/credit-doc";
import {
  buildPaymentChannelDoc,
  PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO,
  PAYMENT_CHANNEL_LEGAL_REVIEW_REPLACED,
} from "@/server/payment-doc";
import { createFirestoreMock, type InMemoryFirestore, type MockDoc } from "@/test-utils/firestore-mock";

const CREATED = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-04-01T12:00:00.000Z");
const ACTOR: AdminConfigActor = { uid: "admin-1", role: "ADMIN" };

/* ==================== Helpers de test ==================== */

interface SnapshotLike {
  id: string;
  exists: boolean;
  data: () => MockDoc | undefined;
}

interface QueryLike {
  docs: SnapshotLike[];
  empty: boolean;
  size: number;
}

/**
 * Envuelve el mock para que **cada lectura devuelva un objeto nuevo**, como hace Firestore.
 *
 * No es un detalle: el mock en memoria guarda el mismo objeto en el `Map` y lo devuelve por
 * referencia, así que `tier === current` — comparar el doc editado por *identidad de objeto* — pasa
 * los tests del mock y falla contra el proyecto real, donde cada lectura deserializa de nuevo. Con
 * esta envoltura, un código que compare por identidad falla en el test, que es justo cuando se
 * quiere.
 */
function firestoreWithFreshReads(db: Firestore): Firestore {
  const wrapSnapshot = (snap: SnapshotLike): SnapshotLike => ({
    id: snap.id,
    exists: snap.exists,
    data: () => {
      const data = snap.data();
      return data === undefined ? undefined : (structuredClone(data) as MockDoc);
    },
  });

  const wrapResult = (result: unknown): unknown => {
    if (result && typeof result === "object") {
      if ("exists" in result && typeof (result as { data?: unknown }).data === "function") {
        return wrapSnapshot(result as SnapshotLike);
      }
      if (Array.isArray((result as { docs?: unknown }).docs)) {
        const query = result as QueryLike;
        return { ...query, docs: query.docs.map((doc) => wrapSnapshot(doc)) };
      }
    }
    return result;
  };

  const wrapTx = (tx: {
    get: (target: unknown) => Promise<unknown>;
    set: (ref: unknown, data: MockDoc, options?: unknown) => void;
    update: (ref: unknown, data: MockDoc) => void;
    delete: (ref: unknown) => void;
  }) => ({
    get: async (target: unknown) => wrapResult(await tx.get(target)),
    set: (ref: unknown, data: MockDoc, options?: unknown) => tx.set(ref, data, options),
    update: (ref: unknown, data: MockDoc) => tx.update(ref, data),
    delete: (ref: unknown) => tx.delete(ref),
  });

  return {
    collection: (name: string) => {
      const collection = db.collection(name);
      return {
        doc: (id?: string) => {
          // El servicio siempre pide id (`collection.doc(code)`); el overload sin argumento del SDK
          // genera un id automático y no hace falta replicarlo.
          const ref = id === undefined ? collection.doc() : collection.doc(id);
          return { ...ref, get: async () => wrapResult(await ref.get()) };
        },
        get: async () => wrapResult(await collection.get()),
        where: (field: string, op: "==", value: unknown) => {
          const chain = collection.where(field, op, value) as unknown as {
            get: () => Promise<QueryLike>;
            runQuery: () => QueryLike;
          };
          return {
            ...chain,
            get: async () => wrapResult(await chain.get()),
            runQuery: () => wrapResult(chain.runQuery()),
          };
        },
      };
    },
    runTransaction: (fn: (t: unknown) => Promise<unknown>) =>
      db.runTransaction((t) => fn(wrapTx(t as Parameters<typeof wrapTx>[0]))),
  } as unknown as Firestore;
}

function seedProduct(store: InMemoryFirestore, code = "MICRO"): void {
  store.seed(
    "credit_products",
    code,
    buildCreditProductDoc(
      {
        name: "Credito personal",
        currency: Currency.COP,
        termFrequency: TermFrequency.MONTHLY,
        termInstallments: 3,
        minTermInstallments: 2,
        maxTermInstallments: 6,
        effectiveFeeBps: 1800,
        isActive: true,
      },
      CREATED,
    ) as unknown as MockDoc,
  );
}

function seedTier(store: InMemoryFirestore, position: number, amountPesos: number, isActive = true): void {
  store.seed(
    "product_tiers",
    `MICRO_${position}`,
    buildProductTierDoc({ productCode: "MICRO", position, amountPesos, isActive }, CREATED) as unknown as MockDoc,
  );
}

function seedRate(store: InMemoryFirestore, version: number, isActive: boolean): void {
  store.seed(
    "interest_rates",
    `MICRO_v${version}`,
    buildInterestRateDoc(
      {
        productType: "MICRO",
        annualRateBps: 2400,
        maximumRateBps: 3500,
        effectiveFrom: CREATED,
        source: "Resolución 001",
        version,
        isActive,
      },
      CREATED,
    ) as unknown as MockDoc,
  );
}

function seedChannel(store: InMemoryFirestore, meta: Record<string, unknown> = { demo: true }): void {
  store.seed(
    "payment_channels",
    "NEQUI",
    buildPaymentChannelDoc(
      {
        name: "Nequi",
        type: "NEQUI",
        instructionsText: "Paga desde la app",
        meta,
        isActive: true,
      },
      CREATED,
    ) as unknown as MockDoc,
  );
}

function setup(): { store: InMemoryFirestore; db: Firestore } {
  const { store, db } = createFirestoreMock();
  return { store, db: firestoreWithFreshReads(db) };
}

async function expectAppError(
  fn: () => Promise<unknown>,
  code: ErrorCode,
  status: number,
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  assertAppError(thrown, code, status);
}

/** Igual, para las funciones de dominio que son síncronas y lanzan sin `await`. */
function expectAppErrorSync(fn: () => unknown, code: ErrorCode, status: number): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assertAppError(thrown, code, status);
}

function assertAppError(thrown: unknown, code: ErrorCode, status: number): void {
  expect(thrown).toBeInstanceOf(AppError);
  const error = thrown as AppError;
  expect(error.code).toBe(code);
  expect(error.statusCode).toBe(status);
}

function audits(store: InMemoryFirestore): MockDoc[] {
  return store.list("audit_logs");
}

/* ==================== Producto ==================== */

describe("updateCreditProduct", () => {
  it("edita los términos y conserva el createdAt original", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000);

    await updateCreditProduct(db, ACTOR, { productCode: "MICRO", name: "Credito_plus", reason: "nueva tarifa" }, LATER);

    const doc = store.read("credit_products", "MICRO")!;
    expect(doc["name"]).toBe("Credito_plus");
    expect(doc["updatedAt"]).toEqual(LATER);
    // El builder fija `createdAt: now`; sin restaurarlo, cada parche mentiría sobre cuándo entró
    // la configuración original.
    expect(doc["createdAt"]).toEqual(CREATED);
  });

  it("escribe la auditoría con el diff campo a campo y el motivo", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000);

    await updateCreditProduct(db, ACTOR, { productCode: "MICRO", effectiveFeeBps: 2400, reason: "ajuste por tasa" }, LATER);

    const logs = audits(store);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorId: "admin-1",
      actorRole: "ADMIN",
      action: AuditAction.CONFIG_CHANGED,
      entityType: "credit_product",
      entityId: "MICRO",
      metadata: {
        reason: "ajuste por tasa",
        changes: [{ field: "effectiveFeeBps", before: 1800, after: 2400 }],
      },
    });
  });

  it("rechaza guardar sin cambios y no escribe ni doc ni auditoría", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000);

    await expectAppError(
      () => updateCreditProduct(db, ACTOR, { productCode: "MICRO", name: "Credito personal", reason: "nada" }, LATER),
      ErrorCode.VALIDATION,
      400,
    );
    expect(store.read("credit_products", "MICRO")!["updatedAt"]).toEqual(CREATED);
    expect(audits(store)).toHaveLength(0);
  });

  it("rechaza activar un producto que se quedaría sin tiers activos", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000, false);

    await expectAppError(
      () => updateCreditProduct(db, ACTOR, { productCode: "MICRO", isActive: true, reason: "reabrir" }, LATER),
      ErrorCode.CONFLICT,
      409,
    );
  });

  it("rechaza un rango de plazo incoherente", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000);

    await expect(
      updateCreditProduct(
        db,
        ACTOR,
        { productCode: "MICRO", minTermInstallments: 5, maxTermInstallments: 3, reason: "incoherente" },
        LATER,
      ),
    ).rejects.toThrow();
  });

  it("da 404 si el producto no existe", async () => {
    const { db } = setup();
    await expectAppError(
      () => updateCreditProduct(db, ACTOR, { productCode: "NO_EXISTE", name: "x", reason: "prueba" }, LATER),
      ErrorCode.NOT_FOUND,
      404,
    );
  });
});

/* ==================== Tiers ==================== */

describe("createProductTier", () => {
  it("crea el tier con el id derivado de código y posición", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000);

    const { id } = await createProductTier(
      db,
      ACTOR,
      { productCode: "MICRO", position: 2, amountPesos: 400_000, reason: "nuevo rung" },
      { idempotencyKey: "tier-2" },
      LATER,
    );

    expect(id).toBe("MICRO_2");
    expect(store.read("product_tiers", "MICRO_2")).toMatchObject({
      productCode: "MICRO",
      position: 2,
      amountPesos: 400_000,
      isActive: true,
    });
    expect(audits(store)).toHaveLength(1);
  });

  it("rechaza una posición ocupada en vez de pisar el tier que hay", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000);

    await expectAppError(
      () =>
        createProductTier(
          db,
          ACTOR,
          { productCode: "MICRO", position: 1, amountPesos: 999_000, reason: "reemplazar" },
          { idempotencyKey: "tier-1-bis" },
          LATER,
        ),
      ErrorCode.VALIDATION,
      400,
    );
    expect(store.read("product_tiers", "MICRO_1")!["amountPesos"]).toBe(200_000);
    expect(audits(store)).toHaveLength(0);
  });

  it("rechaza que el monto no suba con la posición", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 400_000);

    await expectAppError(
      () =>
        createProductTier(
          db,
          ACTOR,
          { productCode: "MICRO", position: 2, amountPesos: 300_000, reason: "inverted" },
          { idempotencyKey: "tier-2-bad" },
          LATER,
        ),
      ErrorCode.CONFLICT,
      409,
    );
    expect(store.read("product_tiers", "MICRO_2")).toBeUndefined();
  });

  it("rechaza un tier de un producto inexistente", async () => {
    const { db } = setup();
    await expectAppError(
      () =>
        createProductTier(
          db,
          ACTOR,
          { productCode: "FANTASMA", position: 1, amountPesos: 100_000, reason: "inventado" },
          { idempotencyKey: "fantasma" },
          LATER,
        ),
      ErrorCode.NOT_FOUND,
      404,
    );
  });

  it("un replay con la misma clave devuelve el mismo tier y no crea un segundo", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000);

    const input = { productCode: "MICRO", position: 2, amountPesos: 400_000, reason: "nuevo rung" };
    const first = await createProductTier(db, ACTOR, input, { idempotencyKey: "tier-doble" }, LATER);
    const second = await createProductTier(db, ACTOR, input, { idempotencyKey: "tier-doble" }, LATER);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(store.ids("product_tiers").filter((id) => id === "MICRO_2")).toHaveLength(1);
    // El replay no vuelve a escribir: auditaría dos veces el mismo alta.
    expect(audits(store)).toHaveLength(1);
  });
});

describe("updateProductTier", () => {
  it("valida el estado resultante, no el que había antes del cambio", async () => {
    // Este es el test que distingue una implementación correcta de una que compara por identidad
    // de objeto. Bajar el tier 2 por debajo del 1 deja la escalera al revés: hay que rechazarlo, y
    // para verlo la lectura tiene que devolver un doc nuevo como en Firestore.
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000);
    seedTier(store, 2, 400_000);

    await expectAppError(
      () => updateProductTier(db, ACTOR, { tierId: "MICRO_2", amountPesos: 150_000, reason: "bajar" }, LATER),
      ErrorCode.CONFLICT,
      409,
    );
    expect(store.read("product_tiers", "MICRO_2")!["amountPesos"]).toBe(400_000);
  });

  it("rechaza desactivar el último tier activo de un producto activo", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000);

    await expectAppError(
      () => updateProductTier(db, ACTOR, { tierId: "MICRO_1", isActive: false, reason: "cerrar" }, LATER),
      ErrorCode.CONFLICT,
      409,
    );
    expect(store.read("product_tiers", "MICRO_1")!["isActive"]).toBe(true);
  });

  it("conserva el createdAt y audita solo el campo que cambió", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000);
    seedTier(store, 2, 400_000);

    await updateProductTier(db, ACTOR, { tierId: "MICRO_2", amountPesos: 500_000, reason: "recalibrar" }, LATER);

    const doc = store.read("product_tiers", "MICRO_2")!;
    expect(doc["amountPesos"]).toBe(500_000);
    expect(doc["createdAt"]).toEqual(CREATED);
    expect(audits(store)[0]).toMatchObject({
      entityType: "product_tier",
      entityId: "MICRO_2",
      metadata: { changes: [{ field: "amountPesos", before: 400_000, after: 500_000 }] },
    });
  });

  it("no deja subir el monto de un rung que está por debajo del siguiente", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 1, 200_000);
    seedTier(store, 2, 400_000);

    await expectAppError(
      () => updateProductTier(db, ACTOR, { tierId: "MICRO_1", amountPesos: 450_000, reason: "subir" }, LATER),
      ErrorCode.CONFLICT,
      409,
    );
  });

  it("da 404 si el tier no existe", async () => {
    const { db } = setup();
    await expectAppError(
      () => updateProductTier(db, ACTOR, { tierId: "MICRO_9", amountPesos: 100_000, reason: "x" }, LATER),
      ErrorCode.NOT_FOUND,
      404,
    );
  });
});

/* ==================== Tasas ==================== */

describe("parseEffectiveFrom", () => {
  it("acepta una fecha válida y la guarda a medianoche UTC", () => {
    expect(parseEffectiveFrom("2026-04-01")).toEqual(new Date("2026-04-01T00:00:00.000Z"));
  });

  it("rechaza una fecha que no existe en el calendario", () => {
    // `new Date("2026-02-31")` no da NaN: normaliza al 3 de marzo y aceptaría una fecha imposible.
    expectAppErrorSync(() => parseEffectiveFrom("2026-02-31"), ErrorCode.VALIDATION, 400);
    expectAppErrorSync(() => parseEffectiveFrom("2026-13-01"), ErrorCode.VALIDATION, 400);
    expectAppErrorSync(() => parseEffectiveFrom("2026-2-1"), ErrorCode.VALIDATION, 400);
  });

  it("acepta el 29 de febrero en año bisiesto y lo rechaza en el que no", () => {
    expect(parseEffectiveFrom("2028-02-29")).toEqual(new Date("2028-02-29T00:00:00.000Z"));
    expectAppErrorSync(() => parseEffectiveFrom("2026-02-29"), ErrorCode.VALIDATION, 400);
  });
});

describe("createInterestRateVersion", () => {
  it("publica la versión siguiente del producto y devuelve el doc guardado", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedRate(store, 1, false);
    seedRate(store, 2, true);

    const { id, doc, replayed } = await createInterestRateVersion(
      db,
      ACTOR,
      {
        productType: "MICRO",
        annualRateBps: 2600,
        maximumRateBps: 3500,
        effectiveFrom: "2026-04-01",
        source: "Resolución 002",
        reason: "nueva tasa",
      },
      { idempotencyKey: "rate-3" },
      LATER,
    );

    expect(replayed).toBe(false);
    expect(id).toBe("MICRO_v3");
    expect(doc.version).toBe(3);
    expect(doc.annualRateBps).toBe(2600);
    expect(doc.effectiveFrom).toEqual(new Date("2026-04-01T00:00:00.000Z"));
    expect(doc.isActive).toBe(true);
    // La respuesta tiene que ser el doc que quedó en Firestore, no el candidato en memoria: si
    // difieren (por ejemplo en los tipos de fecha), el route mentiría sobre lo que se guardó.
    expect(doc).toEqual(store.read("interest_rates", "MICRO_v3"));
    expect(audits(store)).toHaveLength(1);
  });

  it("no reutiliza una versión existente cuando hay huecos", async () => {
    // Con versiones 1, 2 y 7 publicadas la nueva es la 8. Reservar por conteo (4) pisaría `_v4` con
    // una tasa que ya estaba sirviendo préstamos.
    const { store, db } = setup();
    seedProduct(store);
    seedRate(store, 1, false);
    seedRate(store, 2, false);
    seedRate(store, 7, true);

    const { id } = await createInterestRateVersion(
      db,
      ACTOR,
      {
        productType: "MICRO",
        annualRateBps: 2600,
        maximumRateBps: 3500,
        effectiveFrom: "2026-04-01",
        source: "Resolución 003",
        reason: "sube la tasa",
      },
      { idempotencyKey: "rate-8" },
      LATER,
    );

    expect(id).toBe("MICRO_v8");
    expect(store.read("interest_rates", "MICRO_v4")).toBeUndefined();
  });

  it("un replay con la misma clave devuelve la misma versión sin publicar otra", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedRate(store, 1, true);

    const input = {
      productType: "MICRO",
      annualRateBps: 2600,
      maximumRateBps: 3500,
      effectiveFrom: "2026-04-01",
      source: "Resolución 002",
      reason: "nueva tasa",
    };
    const first = await createInterestRateVersion(db, ACTOR, input, { idempotencyKey: "rate-doble" }, LATER);
    const second = await createInterestRateVersion(db, ACTOR, input, { idempotencyKey: "rate-doble" }, LATER);

    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(store.ids("interest_rates")).toEqual(["MICRO_v1", "MICRO_v2"]);
    expect(audits(store)).toHaveLength(1);
  });

  it("rechaza una tasa de un producto inexistente", async () => {
    const { db } = setup();
    await expectAppError(
      () =>
        createInterestRateVersion(
          db,
          ACTOR,
          {
            productType: "FANTASMA",
            annualRateBps: 2600,
            maximumRateBps: 3500,
            effectiveFrom: "2026-04-01",
            source: "Resolución",
            reason: "inventada",
          },
          { idempotencyKey: "rate-fantasma" },
          LATER,
        ),
      ErrorCode.NOT_FOUND,
      404,
    );
  });

  it("rechaza una fecha de vigencia que no existe", async () => {
    const { store, db } = setup();
    seedProduct(store);

    await expectAppError(
      () =>
        createInterestRateVersion(
          db,
          ACTOR,
          {
            productType: "MICRO",
            annualRateBps: 2600,
            maximumRateBps: 3500,
            effectiveFrom: "2026-02-31",
            source: "Resolución",
            reason: "fecha mala",
          },
          { idempotencyKey: "rate-fecha" },
          LATER,
        ),
      ErrorCode.VALIDATION,
      400,
    );
  });
});

describe("setInterestRateActive", () => {
  it("desactiva una versión anterior dejando la vigente intacta", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedRate(store, 1, false);
    seedRate(store, 2, true);

    const { id, doc } = await setInterestRateActive(db, ACTOR, { rateId: "MICRO_v1", isActive: true, reason: "reactivar" }, LATER);

    expect(id).toBe("MICRO_v1");
    expect(doc.isActive).toBe(true);
    expect(doc.createdAt).toEqual(CREATED);
    expect(store.read("interest_rates", "MICRO_v2")!["isActive"]).toBe(true);
    expect(audits(store)[0]).toMatchObject({
      entityType: "interest_rate",
      metadata: { changes: [{ field: "isActive", before: false, after: true }] },
    });
  });

  it("rechaza quedarse sin tasa activa en un producto activo", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedRate(store, 1, true);

    await expectAppError(
      () => setInterestRateActive(db, ACTOR, { rateId: "MICRO_v1", isActive: false, reason: "cerrar" }, LATER),
      ErrorCode.CONFLICT,
      409,
    );
    expect(store.read("interest_rates", "MICRO_v1")!["isActive"]).toBe(true);
    expect(audits(store)).toHaveLength(0);
  });

  it("rechaza guardar sin cambios", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedRate(store, 1, true);

    await expectAppError(
      () => setInterestRateActive(db, ACTOR, { rateId: "MICRO_v1", isActive: true, reason: "nada" }, LATER),
      ErrorCode.VALIDATION,
      400,
    );
  });
});

/* ==================== Umbrales ==================== */

describe("updateDelinquencyThresholds", () => {
  function seedThresholds(store: InMemoryFirestore, value: Record<string, unknown>): void {
    store.seed("system_config", "delinquency", { value, updatedBy: "seed", updatedAt: CREATED });
  }

  it("guarda los tres cortes y los audita", async () => {
    const { store, db } = setup();
    seedThresholds(store, { dueSoonDays: 3, overdueDays: 15, defaultDays: 30 });

    const saved = await updateDelinquencyThresholds(
      db,
      ACTOR,
      { dueSoonDays: 5, overdueDays: 15, defaultDays: 45, reason: "ajuste operativo" },
      LATER,
    );

    expect(saved).toEqual({ dueSoonDays: 5, overdueDays: 15, defaultDays: 45 });
    expect(store.read("system_config", "delinquency")).toMatchObject({
      value: { dueSoonDays: 5, overdueDays: 15, defaultDays: 45 },
      updatedBy: "admin-1",
    });
    expect(audits(store)[0]).toMatchObject({
      entityType: "system_config",
      entityId: "delinquency",
      metadata: {
        changes: [
          { field: "dueSoonDays", before: 3, after: 5 },
          { field: "defaultDays", before: 30, after: 45 },
        ],
      },
    });
  });

  it("rechaza una ventana de aviso que llega al atraso", async () => {
    const { store, db } = setup();
    seedThresholds(store, { dueSoonDays: 3, overdueDays: 15, defaultDays: 30 });

    await expectAppError(
      () =>
        updateDelinquencyThresholds(
          db,
          ACTOR,
          { dueSoonDays: 20, overdueDays: 15, defaultDays: 30, reason: "invertido" },
          LATER,
        ),
      ErrorCode.VALIDATION,
      400,
    );
    expect(store.read("system_config", "delinquency")!["value"]).toEqual({
      dueSoonDays: 3,
      overdueDays: 15,
      defaultDays: 30,
    });
  });

  it("rechaza guardar los mismos valores", async () => {
    const { store, db } = setup();
    seedThresholds(store, { dueSoonDays: 3, overdueDays: 15, defaultDays: 30 });

    await expectAppError(
      () =>
        updateDelinquencyThresholds(
          db,
          ACTOR,
          { dueSoonDays: 3, overdueDays: 15, defaultDays: 30, reason: "nada" },
          LATER,
        ),
      ErrorCode.VALIDATION,
      400,
    );
    expect(audits(store)).toHaveLength(0);
  });
});

/* ==================== Canales ==================== */

describe("updatePaymentChannel", () => {
  it("escribe los datos públicos y conserva los marcadores que no toca", async () => {
    const { store, db } = setup();
    seedChannel(store, { demo: true, legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO });

    await updatePaymentChannel(
      db,
      ACTOR,
      {
        channelId: "NEQUI",
        name: "Nequi (oficial)",
        publicMeta: { bankName: "Nequi", accountNumber: "  123  " },
        reason: "datos reales del banco",
      },
      LATER,
    );

    const doc = store.read("payment_channels", "NEQUI")!;
    expect(doc["name"]).toBe("Nequi (oficial)");
    expect(doc["meta"]).toMatchObject({
      bankName: "Nequi",
      accountNumber: "123",
      demo: true,
      legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO,
    });
    expect(doc["createdAt"]).toEqual(CREATED);
    expect(audits(store)[0]).toMatchObject({ entityType: "payment_channel", entityId: "NEQUI" });
  });

  it("rechaza activar un canal sin nombre", async () => {
    const { store, db } = setup();
    seedChannel(store);

    await expectAppError(
      () => updatePaymentChannel(db, ACTOR, { channelId: "NEQUI", name: "  ", reason: "sin nombre" }, LATER),
      ErrorCode.VALIDATION,
      400,
    );
  });

  it("reemplazar los datos del banco borra la marca demo y deja revisión legal pendiente", async () => {
    const { store, db } = setup();
    seedChannel(store, { demo: true, legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO });

    await updatePaymentChannel(
      db,
      ACTOR,
      {
        channelId: "NEQUI",
        publicMeta: { accountNumber: "123" },
        dataReplaced: true,
        reason: "el banco ya dio los datos reales",
      },
      LATER,
    );

    const meta = store.read("payment_channels", "NEQUI")!["meta"] as Record<string, unknown>;
    expect(meta["demo"]).toBeUndefined();
    expect(meta["legalReview"]).toBe(PAYMENT_CHANNEL_LEGAL_REVIEW_REPLACED);
  });

  it("guardar la cuenta nueva no borra la advertencia legal por su cuenta", async () => {
    const { store, db } = setup();
    seedChannel(store, { demo: true, legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO });

    await updatePaymentChannel(
      db,
      ACTOR,
      { channelId: "NEQUI", publicMeta: { accountNumber: "123" }, reason: "solo la cuenta" },
      LATER,
    );

    const meta = store.read("payment_channels", "NEQUI")!["meta"] as Record<string, unknown>;
    expect(meta["demo"]).toBe(true);
    expect(meta["legalReview"]).toBe(PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO);
  });

  it("un texto vacío borra la clave en vez de guardar cadena vacía", async () => {
    const { store, db } = setup();
    seedChannel(store, { demo: true, bankName: "Nequi" });

    await updatePaymentChannel(
      db,
      ACTOR,
      { channelId: "NEQUI", publicMeta: { bankName: "   " }, reason: "quitar el banco" },
      LATER,
    );

    const meta = store.read("payment_channels", "NEQUI")!["meta"] as Record<string, unknown>;
    expect("bankName" in meta).toBe(false);
  });
});

/* ==================== Lectura ==================== */

describe("listAdminConfig", () => {
  it("agrupa los tiers bajo su producto y ordena por posición", async () => {
    const { store, db } = setup();
    seedProduct(store);
    seedTier(store, 2, 400_000);
    seedTier(store, 1, 200_000);
    seedRate(store, 1, true);
    seedChannel(store);
    store.seed("system_config", "delinquency", { value: { dueSoonDays: 3, overdueDays: 15, defaultDays: 30 } });

    const config = await listAdminConfig(db);

    expect(config.products).toHaveLength(1);
    expect(config.products[0]!.id).toBe("MICRO");
    expect(config.products[0]!.tiers.map((tier) => tier.position)).toEqual([1, 2]);
    expect(config.products[0]!.tiers[0]!.id).toBe("MICRO_1");
    expect(config.rates.map((rate) => rate.id)).toEqual(["MICRO_v1"]);
    expect(config.thresholds?.value).toEqual({ dueSoonDays: 3, overdueDays: 15, defaultDays: 30 });
  });

  it("deriva de meta si el canal es de demostración y qué revisión legal tiene", async () => {
    const { store, db } = setup();
    seedChannel(store, { demo: true, legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO });

    const config = await listAdminConfig(db);
    expect(config.channels[0]).toMatchObject({
      id: "NEQUI",
      isDemoData: true,
      legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO,
    });
  });

  it("deja el producto sin tiers cuando no tiene ninguno", async () => {
    const { store, db } = setup();
    seedProduct(store);

    const config = await listAdminConfig(db);
    expect(config.products[0]!.tiers).toEqual([]);
  });

  it("devuelve umbrales null si nunca se configuraron", async () => {
    const { store, db } = setup();
    seedProduct(store);

    const config = await listAdminConfig(db);
    expect(config.thresholds).toBeNull();
  });
});