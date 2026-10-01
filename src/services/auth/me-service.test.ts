import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { Role, UserStatus } from "@/server/types";
import { getMe, patchMeProfile, type MeDeps } from "./me-service";

interface MockUserDoc {
  email: string;
  fullName: string;
  phone: string;
  role: string;
  status: string;
  createdAt: { toMillis: () => number };
  updatedAt: { toMillis: () => number };
  [key: string]: unknown;
}

interface ProfileResponse {
  ok: boolean;
  profile: {
    city: string | null;
    occupation: string | null;
    monthlyIncomeRange: string | null;
    updatedAt: number | null;
  };
}

interface GetMeResponse {
  uid: string;
  email: string;
  role: string;
  status: string;
  fullName: string;
  phone: string;
  createdAt: number;
  updatedAt: number;
  profile: {
    city: string | null;
    occupation: string | null;
    monthlyIncomeRange: string | null;
    updatedAt: number;
  };
}

function fakeCookieStore(cookieValue?: string) {
  return {
    get: (name: string) => (name === "__session" && cookieValue ? { name, value: cookieValue } : undefined),
  };
}

function fakeAuth(overrides: Record<string, unknown> = {}): Auth {
  return {
    verifySessionCookie: vi.fn(async (cookie: string, _checkRevoked: boolean) => {
      if (cookie === "cookie-revocada" || (overrides.revoked && cookie === "cookie-ok")) {
        const error = new Error("revocada");
        (error as Error & { code: string }).code = "auth/session-cookie-revoked";
        throw error;
      }
      if (cookie === "cookie-invalida") {
        const error = new Error("invalida");
        (error as Error & { code: string }).code = "auth/argument-error";
        throw error;
      }
      return { uid: "uid-1", email: "persona@local.dev" };
    }),
    ...overrides,
  } as unknown as Auth;
}

function createTimestampMock(ms: number) {
  return { toMillis: () => ms };
}

function fakeDb(userDoc?: MockUserDoc, profileDoc?: Record<string, unknown>): Firestore {
  const store = new Map<string, Record<string, unknown>>();
  if (userDoc) {
    store.set("users/uid-1", userDoc);
  }
  if (profileDoc) {
    store.set("user_profiles/uid-1", profileDoc);
  }
  return {
    collection: vi.fn((name: string) => ({
      doc: vi.fn((id: string) => ({
        get: vi.fn(async () => {
          const key = `${name}/${id}`;
          if (store.has(key)) {
            const data = store.get(key)!;
            const cleaned = Object.fromEntries(
              Object.entries(data).filter(([, v]) => !(v !== null && typeof v === "object" && v.constructor && v.constructor.name === "DeleteTransform")),
            );
            return { exists: true, data: () => cleaned };
          }
          return { exists: false };
        }),
        set: vi.fn(async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
          const key = `${name}/${id}`;
          if (options?.merge) {
            const existing = store.get(key) ?? {};
            const merged = { ...existing };
            for (const [k, v] of Object.entries(data)) {
              if (v !== null && typeof v === "object" && v.constructor && v.constructor.name === "DeleteTransform") {
                delete merged[k];
              } else {
                merged[k] = v;
              }
            }
            store.set(key, merged);
          } else {
            store.set(key, data);
          }
        }),
      })),
    })),
  } as unknown as Firestore;
}

const defaultUser: MockUserDoc = {
  email: "persona@local.dev",
  fullName: "Persona Uno",
  phone: "+573001234567",
  role: Role.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: createTimestampMock(new Date().getTime()),
  updatedAt: createTimestampMock(new Date().getTime()),
};

const defaultProfile = {
  city: "Bogotá",
  occupation: "Ingeniero",
  monthlyIncomeRange: "2M-4M",
  updatedAt: createTimestampMock(new Date().getTime()),
};

function buildDeps(overrides: Partial<MeDeps> = {}): MeDeps {
  return {
    auth: fakeAuth(),
    db: fakeDb(defaultUser, defaultProfile),
    cookies: fakeCookieStore("cookie-ok"),
    ...overrides,
  };
}

describe("me-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getMe", () => {
    it("200: devuelve el perfil completo del usuario", async () => {
      const deps = buildDeps();
      const result = await getMe(deps);

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        uid: "uid-1",
        email: "persona@local.dev",
        role: Role.CUSTOMER,
        status: UserStatus.ACTIVE,
        fullName: "Persona Uno",
        phone: "+573001234567",
        profile: {
          city: "Bogotá",
          occupation: "Ingeniero",
          monthlyIncomeRange: "2M-4M",
        },
      });
    });

    it("401: sin cookie", async () => {
      const deps = buildDeps({ cookies: fakeCookieStore() });
      const result = await getMe(deps);

      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    });

    it("401: cookie inválida", async () => {
      const deps = buildDeps({ cookies: fakeCookieStore("cookie-invalida") });
      const result = await getMe(deps);

      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    });

    it("401: cookie revocada", async () => {
      const deps = buildDeps({ auth: fakeAuth({ revoked: true }), cookies: fakeCookieStore("cookie-ok") });
      const result = await getMe(deps);

      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    });

    it("401: usuario no existe en Firestore", async () => {
      const deps = buildDeps({ db: fakeDb() });
      const result = await getMe(deps);

      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    });

    it("incluye timestamps en milisegundos", async () => {
      const nowMs = new Date("2026-09-25T12:00:00.000Z").getTime();
      const userDoc = { ...defaultUser, createdAt: createTimestampMock(nowMs), updatedAt: createTimestampMock(nowMs) };
      const profileDoc = { ...defaultProfile, updatedAt: createTimestampMock(nowMs) };
      const deps = buildDeps({ db: fakeDb(userDoc, profileDoc) });
      const result = await getMe(deps);

      expect(result.status).toBe(200);
      const body = result.body as GetMeResponse;
      expect(body.createdAt).toBe(nowMs);
      expect(body.updatedAt).toBe(nowMs);
      expect(body.profile.updatedAt).toBe(nowMs);
    });
  });

  describe("patchMeProfile", () => {
    it("200: actualiza city y occupation", async () => {
      const deps = buildDeps();
      const result = await patchMeProfile(deps, { city: "Medellín", occupation: "Diseñador" });

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        ok: true,
        profile: {
          city: "Medellín",
          occupation: "Diseñador",
          monthlyIncomeRange: "2M-4M",
        },
      });
    });

    it("200: actualiza monthlyIncomeRange válido", async () => {
      const deps = buildDeps();
      const result = await patchMeProfile(deps, { monthlyIncomeRange: "4M-8M" });

      expect(result.status).toBe(200);
      const body = result.body as ProfileResponse;
      expect(body.profile.monthlyIncomeRange).toBe("4M-8M");
    });

    it("400: rechaza monthlyIncomeRange inválido", async () => {
      const deps = buildDeps();
      const result = await patchMeProfile(deps, { monthlyIncomeRange: "INVALIDO" });

      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: "VALIDATION" } });
    });

    it("400: sin campos válidos para actualizar", async () => {
      const deps = buildDeps();
      const result = await patchMeProfile(deps, { campoInexistente: "valor" } as Record<string, unknown>);

      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: "VALIDATION" } });
    });

    it("401: sin cookie", async () => {
      const deps = buildDeps({ cookies: fakeCookieStore() });
      const result = await patchMeProfile(deps, { city: "Medellín" });

      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    });

    it("limpia campos vacíos eliminando el campo", async () => {
      const db = fakeDb(defaultUser, { ...defaultProfile, city: "Bogotá" });
      const deps = buildDeps({ db });
      const result = await patchMeProfile(deps, { city: "" });

      expect(result.status).toBe(200);
      const body = result.body as ProfileResponse;
      expect(body.profile.city).toBeNull();
    });

    it("trim strings antes de guardar", async () => {
      const deps = buildDeps();
      const result = await patchMeProfile(deps, { city: "  Cali  ", occupation: "  Analista  " });

      expect(result.status).toBe(200);
      const body = result.body as ProfileResponse;
      expect(body.profile.city).toBe("Cali");
      expect(body.profile.occupation).toBe("Analista");
    });

    it("persiste los cambios en la base de datos", async () => {
      const db = fakeDb(defaultUser, defaultProfile);
      const deps = buildDeps({ db });
      await patchMeProfile(deps, { city: "Barranquilla" });

      const profileSnap = await db.collection("user_profiles").doc("uid-1").get();
      expect(profileSnap.data()?.city).toBe("Barranquilla");
    });
  });
});