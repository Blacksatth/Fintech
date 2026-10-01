import { describe, expect, it } from "vitest";
import {
  clearUserCreditLimit,
  listUsersWithLimits,
  readActiveCreditLimit,
  setUserCreditLimit,
} from "./user-limit-service";
import { createFirestoreMock, InMemoryFirestore } from "@/test-utils/firestore-mock";
import { AuditAction } from "@/server/types";
import { UserDoc } from "@/server/user-doc";
import { UserStatus } from "@/server/types";
import { UserLimitOverrideDoc } from "@/server/credit-doc";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const LATER = new Date("2026-09-26T12:00:00.000Z");

const ACTOR = { uid: "admin-1", role: "ADMIN" };

function user(uid: string, overrides: Partial<UserDoc> = {}): UserDoc {
  return {
    email: `${uid}@test.dev`,
    fullName: "Usuario de prueba",
    phone: "+573001234567",
    role: "CUSTOMER",
    status: UserStatus.ACTIVE,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Doc de override sembrado tal como lo escribiría el servicio o el seed. */
function override(uid: string, creditLimitPesos: number, overrides: Partial<UserLimitOverrideDoc> = {}): UserLimitOverrideDoc {
  return {
    userId: uid,
    creditLimitPesos,
    overriddenBy: "admin-1",
    reason: "Límite aprobado",
    active: true,
    createdAt: NOW,
    ...overrides,
  };
}

function setup(seeds: { users?: Record<string, UserDoc>; overrides?: Record<string, UserLimitOverrideDoc> } = {}) {
  const { store, db } = createFirestoreMock();
  for (const [uid, doc] of Object.entries(seeds.users ?? {})) store.seed("users", uid, { ...doc });
  for (const [uid, doc] of Object.entries(seeds.overrides ?? {})) {
    store.seed("user_limit_overrides", uid, { ...doc });
  }
  return { store, db };
}

function auditLogs(store: InMemoryFirestore): Array<Record<string, unknown>> {
  return store.list("audit_logs").filter((row) => row["action"] === AuditAction.LIMIT_CHANGED);
}

describe("user-limit-service", () => {
  describe("setUserCreditLimit", () => {
    it("cree el override activo y deje auditoría LIMIT_CHANGED", async () => {
      const { store, db } = setup({ users: { "uid-1": user("uid-1") } });

      const doc = await setUserCreditLimit(db, ACTOR, { userId: "uid-1", creditLimitPesos: 75000, reason: "Límite aprobado" }, NOW);

      expect(store.read("user_limit_overrides", "uid-1")).toEqual({
        userId: "uid-1",
        creditLimitPesos: 75000,
        overriddenBy: "admin-1",
        reason: "Límite aprobado",
        active: true,
        createdAt: NOW,
      });
      expect(doc.active).toBe(true);

      const logs = auditLogs(store);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        actorId: "admin-1",
        actorRole: "ADMIN",
        action: AuditAction.LIMIT_CHANGED,
        entityType: "user",
        entityId: "uid-1",
        metadata: { creditLimitPesos: 75000, reason: "Límite aprobado" },
        createdAt: NOW,
      });
    });

    it("sobrescriba el override previo de un mismo usuario (un solo doc)", async () => {
      const { store, db } = setup({
        users: { "uid-1": user("uid-1") },
        overrides: { "uid-1": override("uid-1", 50000, { createdAt: NOW }) },
      });

      const doc = await setUserCreditLimit(db, ACTOR, { userId: "uid-1", creditLimitPesos: 100000, reason: "Sube a 100k" }, LATER);

      const stored = store.read("user_limit_overrides", "uid-1");
      expect(stored).toEqual({
        userId: "uid-1",
        creditLimitPesos: 100000,
        overriddenBy: "admin-1",
        reason: "Sube a 100k",
        active: true,
        createdAt: LATER,
      });
      expect(doc.createdAt).toBe(LATER);
      expect(auditLogs(store)).toHaveLength(1);
    });

    it("falle si el usuario no existe", async () => {
      const { db } = setup();

      await expect(
        setUserCreditLimit(db, ACTOR, { userId: "uid-fantasma", creditLimitPesos: 75000, reason: "X" }, NOW),
      ).rejects.toThrow("no encontrado");
    });

    it("rechace un monto no entero, no positivo o fuera de rango entero seguro", async () => {
      const { store, db } = setup({ users: { "uid-1": user("uid-1") } });

      for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
        await expect(
          setUserCreditLimit(db, ACTOR, { userId: "uid-1", creditLimitPesos: bad, reason: "X" }, NOW),
        ).rejects.toThrow();
      }
      expect(store.ids("user_limit_overrides")).toHaveLength(0);
    });

    it("use una razón por defecto si no viene", async () => {
      const { store, db } = setup({ users: { "uid-1": user("uid-1") } });

      await setUserCreditLimit(db, ACTOR, { userId: "uid-1", creditLimitPesos: 75000 }, NOW);

      const stored = store.read("user_limit_overrides", "uid-1") as unknown as UserLimitOverrideDoc;
      expect(stored.reason.length).toBeGreaterThan(0);
    });
  });

  describe("clearUserCreditLimit", () => {
    it("marque el override como inactivo y deje auditoría", async () => {
      const { store, db } = setup({
        users: { "uid-1": user("uid-1") },
        overrides: { "uid-1": override("uid-1", 75000) },
      });

      await clearUserCreditLimit(db, ACTOR, { userId: "uid-1", reason: "Se revoca el límite" }, LATER);

      const stored = store.read("user_limit_overrides", "uid-1") as unknown as UserLimitOverrideDoc;
      expect(stored.active).toBe(false);
      expect(stored.creditLimitPesos).toBe(75000);
      expect(stored.reason).toBe("Se revoca el límite");

      const logs = auditLogs(store);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ action: AuditAction.LIMIT_CHANGED, metadata: { creditLimitPesos: null, reason: "Se revoca el límite" } });
    });

    it("no escriba nada ni audite si no hay override", async () => {
      const { store, db } = setup({ users: { "uid-1": user("uid-1") } });

      await clearUserCreditLimit(db, ACTOR, { userId: "uid-1", reason: "Sin límite previo" }, NOW);

      expect(store.ids("user_limit_overrides")).toHaveLength(0);
      expect(auditLogs(store)).toHaveLength(0);
    });
  });

  describe("readActiveCreditLimit", () => {
    it("retorne el monto si el override está activo", async () => {
      const { db } = setup({ overrides: { "uid-1": override("uid-1", 75000) } });

      expect(await readActiveCreditLimit(db, "uid-1")).toBe(75000);
    });

    it("retorne null si el override existe pero está inactivo", async () => {
      const { db } = setup({ overrides: { "uid-1": override("uid-1", 75000, { active: false }) } });

      expect(await readActiveCreditLimit(db, "uid-1")).toBeNull();
    });

    it("retorne null si no hay override", async () => {
      const { db } = setup();

      expect(await readActiveCreditLimit(db, "uid-1")).toBeNull();
    });
  });

  describe("listUsersWithLimits", () => {
    it("liste usuarios junto a su límite activo, ordenados por createdAt desc", async () => {
      const { db } = setup({
        users: {
          "uid-viejo": user("uid-viejo", { createdAt: NOW }),
          "uid-nuevo": user("uid-nuevo", { createdAt: LATER }),
        },
        overrides: { "uid-nuevo": override("uid-nuevo", 100000) },
      });

      const rows = await listUsersWithLimits(db);

      expect(rows.map((r) => r.uid)).toEqual(["uid-nuevo", "uid-viejo"]);
      const nuevo = rows[0];
      expect(nuevo.activeLimit?.creditLimitPesos).toBe(100000);
      expect(rows[1].activeLimit).toBeNull();
      expect(rows[1].user.email).toBe("uid-viejo@test.dev");
    });

    it("retorne vacío si no hay usuarios", async () => {
      const { db } = setup();

      expect(await listUsersWithLimits(db)).toEqual([]);
    });
  });
});
