import { describe, expect, it } from "vitest";
import { idempotencyKeyId, withIdempotency } from "./idempotency";
import type { Firestore } from "firebase-admin/firestore";

interface FakeSnapshot {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

interface FakeTransaction {
  get(ref: { id: string }): Promise<FakeSnapshot>;
  set(ref: { id: string }, data: unknown): void;
  delete(ref: { id: string }): void;
}

function createFakeFirestore() {
  const store = new Map<string, Record<string, unknown>>();
  const transaction: FakeTransaction = {
    async get(ref) {
      const data = store.get(ref.id);
      return { exists: data !== undefined, data: () => data };
    },
    set(ref, data) {
      store.set(ref.id, data as Record<string, unknown>);
    },
    delete(ref) {
      store.delete(ref.id);
    },
  };
  const db = {
    collection: () => ({
      doc: (id: string) => ({ id }),
    }),
    runTransaction: async (fn: (t: FakeTransaction) => unknown) => fn(transaction),
  };
  return { db: db as unknown as Firestore, store, transaction };
}

describe("idempotency (semantica sin red)", () => {
  it("la primera ejecucion corre y el replay no vuelve a ejecutar", async () => {
    const { db } = createFakeFirestore();
    const scope = "payments";
    const key = "k-1";
    let runs = 0;

    const first = await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      entityId: "p-1",
      run: async () => {
        runs += 1;
      },
    });
    expect(first.replayed).toBe(false);
    expect(first.entityType).toBe("payment");
    expect(first.entityId).toBe("p-1");
    expect(runs).toBe(1);

    const replay = await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      entityId: "p-1",
      run: async () => {
        runs += 1;
      },
    });
    expect(replay.replayed).toBe(true);
    expect(runs).toBe(1);
  });

  it("el registro tiene la forma de PROJECT_SPEC 8.1 y no guarda el resultado", async () => {
    const { db, store } = createFakeFirestore();

    await withIdempotency(db, {
      scope: "payments",
      key: "k-shape",
      entityType: "payment",
      entityId: "p-9",
      run: async () => undefined,
    });

    const doc = store.get(idempotencyKeyId("payments", "k-shape"))!;
    expect(Object.keys(doc).sort()).toEqual(
      ["createdAt", "entityId", "entityType", "expiresAt", "key", "scope"].sort(),
    );
    expect(doc.entityType).toBe("payment");
    expect(doc.entityId).toBe("p-9");
    expect(doc).not.toHaveProperty("result");
  });

  it("una clave distinta si ejecuta", async () => {
    const { db, store } = createFakeFirestore();
    const scope = "payments";
    let runs = 0;

    await withIdempotency(db, {
      scope,
      key: "a",
      entityType: "payment",
      entityId: "p-1",
      run: async () => {
        runs += 1;
      },
    });
    await withIdempotency(db, {
      scope,
      key: "b",
      entityType: "payment",
      entityId: "p-2",
      run: async () => {
        runs += 1;
      },
    });
    expect(runs).toBe(2);
    expect(store.size).toBe(2);
  });

  it("una clave vencida se puede re-ejecutar", async () => {
    const { db, store } = createFakeFirestore();
    const scope = "payments";
    const key = "expired";
    let runs = 0;

    await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      entityId: "p-1",
      ttlMs: -1000,
      run: async () => {
        runs += 1;
      },
    });
    store.set(idempotencyKeyId(scope, key), {
      scope,
      key,
      entityType: "payment",
      entityId: "p-1",
      expiresAt: new Date(Date.now() - 1_000),
    });

    const again = await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      entityId: "p-1",
      run: async () => {
        runs += 1;
      },
    });
    expect(again.replayed).toBe(false);
    expect(runs).toBe(2);
  });

  it("un registro de la version previa (con result) igual impide re-ejecutar", async () => {
    const { db, store } = createFakeFirestore();
    const scope = "payments";
    const key = "legacy";
    let runs = 0;

    store.set(idempotencyKeyId(scope, key), {
      scope,
      key,
      result: { ok: true },
      expiresAt: new Date(Date.now() + 60_000),
    });

    const outcome = await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      entityId: "p-1",
      run: async () => {
        runs += 1;
      },
    });
    expect(outcome.replayed).toBe(true);
    expect(runs).toBe(0);
  });

  it("idempotencyKeyId es determinista y distinto por clave", () => {
    const a1 = idempotencyKeyId("payments", "k-1");
    const a2 = idempotencyKeyId("payments", "k-1");
    const b = idempotencyKeyId("payments", "k-2");
    const c = idempotencyKeyId("disbursements", "k-1");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(c);
    expect(a1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("si la entidad se crea en run, manda el id que devuelve run", async () => {
    const { db, store } = createFakeFirestore();
    const scope = "payment.create";
    const key = "k-seq";

    const first = await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      run: async () => ({ entityId: "PAY-2026-0001" }),
    });

    expect(first.replayed).toBe(false);
    expect(first.entityId).toBe("PAY-2026-0001");
    expect(store.get(idempotencyKeyId(scope, key))!["entityId"]).toBe("PAY-2026-0001");
  });

  it("el replay devuelve el id guardado, no el que pasó el llamador", async () => {
    const { db } = createFakeFirestore();
    const scope = "payment.create";
    const key = "k-seq";
    let runs = 0;

    await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      run: async () => {
        runs += 1;
        return { entityId: "PAY-2026-0001" };
      },
    });

    const replay = await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      // El llamador cree que crearía otro pago: el registro dice que ya existe este.
      entityId: "PAY-2026-9999",
      run: async () => {
        runs += 1;
        return { entityId: "PAY-2026-9999" };
      },
    });

    expect(replay.replayed).toBe(true);
    expect(replay.entityId).toBe("PAY-2026-0001");
    expect(runs).toBe(1);
  });

  it("sin entityId en ningun lado aborta y no deja registro", async () => {
    const { db, store } = createFakeFirestore();
    const scope = "payment.create";
    const key = "k-sin-id";

    await expect(
      withIdempotency(db, { scope, key, entityType: "payment", run: async () => undefined }),
    ).rejects.toThrow(/no indicó el id de la entidad/);
    expect(store.size).toBe(0);
  });
});
