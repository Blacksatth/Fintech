import { randomUUID } from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it } from "vitest";
import { idempotencyKeyId, withIdempotency } from "../src/lib/idempotency";
import type { Firestore } from "firebase-admin/firestore";

const activeKeys: string[] = [];

afterEach(async () => {
  const db: Firestore = getFirestore();
  await Promise.all(
    activeKeys.splice(0).map((keyId) => db.collection("idempotency_keys").doc(keyId).delete()),
  );
});

describe("idempotency (Firestore real)", () => {
  it("primera ejecucion corre; el replay no re-ejecuta", async () => {
    const db: Firestore = getFirestore();
    const scope = "integration";
    const key = randomUUID();
    activeKeys.push(idempotencyKeyId(scope, key));
    let runs = 0;

    const first = await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      entityId: "pay-1",
      run: async () => {
        runs += 1;
      },
    });
    expect(first.replayed).toBe(false);
    expect(first.entityId).toBe("pay-1");

    const replay = await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      entityId: "pay-1",
      run: async () => {
        runs += 1;
      },
    });
    expect(replay.replayed).toBe(true);
    expect(runs).toBe(1);
  });

  it("guarda la forma de PROJECT_SPEC 8.1 y no guarda result", async () => {
    const db: Firestore = getFirestore();
    const scope = "integration";
    const key = randomUUID();
    const keyId = idempotencyKeyId(scope, key);
    activeKeys.push(keyId);

    await withIdempotency(db, {
      scope,
      key,
      entityType: "disbursement",
      entityId: "loan-1",
      run: async () => undefined,
    });

    const snap = await db.collection("idempotency_keys").doc(keyId).get();
    const doc = snap.data() as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(
      ["createdAt", "entityId", "entityType", "expiresAt", "key", "scope"].sort(),
    );
    expect(doc.entityType).toBe("disbursement");
    expect(doc.entityId).toBe("loan-1");
    expect(doc.scope).toBe(scope);
    expect(doc.key).toBe(key);
  });

  it("guarda el id que devuelve run y lo devuelve en el replay", async () => {
    const db: Firestore = getFirestore();
    const scope = "integration";
    const key = randomUUID();
    const keyId = idempotencyKeyId(scope, key);
    activeKeys.push(keyId);
    let runs = 0;

    const first = await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      run: async () => {
        runs += 1;
        return { entityId: "PAY-2026-0007" };
      },
    });
    expect(first.replayed).toBe(false);
    expect(first.entityId).toBe("PAY-2026-0007");

    const stored = await db.collection("idempotency_keys").doc(keyId).get();
    expect(stored.data()?.entityId).toBe("PAY-2026-0007");

    const replay = await withIdempotency(db, {
      scope,
      key,
      entityType: "payment",
      entityId: "PAY-2026-9999",
      run: async () => {
        runs += 1;
        return { entityId: "PAY-2026-9999" };
      },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.entityId).toBe("PAY-2026-0007");
    expect(runs).toBe(1);
  });
});
