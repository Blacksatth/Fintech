import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { Role, UserStatus } from "@/server/types";
import { requireUser, requireRole, requireAdmin, assertOwnership } from "./guards";

interface MockUserDoc {
  email: string;
  fullName: string;
  phone: string;
  role: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
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

function fakeDb(userDoc?: MockUserDoc): Firestore {
  const store = new Map<string, MockUserDoc>();
  if (userDoc) {
    store.set("users/uid-1", userDoc);
  }
  return {
    collection: vi.fn((name: string) => ({
      doc: vi.fn((id: string) => ({
        get: vi.fn(async () => {
          const key = `${name}/${id}`;
          if (store.has(key)) {
            return { exists: true, data: () => store.get(key) };
          }
          return { exists: false };
        }),
        set: vi.fn(),
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
  createdAt: new Date(),
  updatedAt: new Date(),
};

const adminUser: MockUserDoc = {
  ...defaultUser,
  role: Role.ADMIN,
};

describe("guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("requireUser", () => {
    it("devuelve el contexto del usuario autenticado", async () => {
      const auth = fakeAuth();
      const db = fakeDb(defaultUser);
      const cookies = fakeCookieStore("cookie-ok");

      const context = await requireUser({ auth, db, cookies });

      expect(context).toEqual({
        uid: "uid-1",
        email: "persona@local.dev",
        role: Role.CUSTOMER,
        status: UserStatus.ACTIVE,
      });
    });

    it("lanza 401 si no hay cookie", async () => {
      const auth = fakeAuth();
      const db = fakeDb(defaultUser);
      const cookies = fakeCookieStore();

      await expect(requireUser({ auth, db, cookies })).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it("lanza 401 si la cookie está revocada", async () => {
      const auth = fakeAuth({ revoked: true });
      const db = fakeDb(defaultUser);
      const cookies = fakeCookieStore("cookie-ok");

      await expect(requireUser({ auth, db, cookies })).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it("lanza 401 si la cookie es inválida", async () => {
      const auth = fakeAuth();
      const db = fakeDb(defaultUser);
      const cookies = fakeCookieStore("cookie-invalida");

      await expect(requireUser({ auth, db, cookies })).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it("lanza 401 si el usuario no existe en Firestore", async () => {
      const auth = fakeAuth();
      const db = fakeDb(); // sin usuario
      const cookies = fakeCookieStore("cookie-ok");

      await expect(requireUser({ auth, db, cookies })).rejects.toMatchObject({
        statusCode: 401,
      });
    });
  });

  describe("requireRole", () => {
    it("permite acceso si el rol está en la lista", async () => {
      const auth = fakeAuth();
      const db = fakeDb(defaultUser);
      const cookies = fakeCookieStore("cookie-ok");

      const context = await requireRole({ auth, db, cookies }, [Role.CUSTOMER, Role.ADMIN]);

      expect(context.role).toBe(Role.CUSTOMER);
    });

    it("lanza 403 si el rol no está en la lista", async () => {
      const auth = fakeAuth();
      const db = fakeDb(defaultUser);
      const cookies = fakeCookieStore("cookie-ok");

      await expect(requireRole({ auth, db, cookies }, [Role.ADMIN])).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it("lanza 403 si el usuario está suspendido", async () => {
      const suspendedUser = { ...defaultUser, status: UserStatus.SUSPENDED };
      const auth = fakeAuth();
      const db = fakeDb(suspendedUser);
      const cookies = fakeCookieStore("cookie-ok");

      await expect(requireRole({ auth, db, cookies }, [Role.CUSTOMER])).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  });

  describe("requireAdmin", () => {
    it("permite acceso a un admin activo", async () => {
      const auth = fakeAuth();
      const db = fakeDb(adminUser);
      const cookies = fakeCookieStore("cookie-ok");

      const context = await requireAdmin({ auth, db, cookies });

      expect(context.role).toBe(Role.ADMIN);
    });

    it("lanza 403 si el usuario no es admin", async () => {
      const auth = fakeAuth();
      const db = fakeDb(defaultUser);
      const cookies = fakeCookieStore("cookie-ok");

      await expect(requireAdmin({ auth, db, cookies })).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it("lanza 403 si el admin está suspendido", async () => {
      const suspendedAdmin = { ...adminUser, status: UserStatus.SUSPENDED };
      const auth = fakeAuth();
      const db = fakeDb(suspendedAdmin);
      const cookies = fakeCookieStore("cookie-ok");

      await expect(requireAdmin({ auth, db, cookies })).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  });

  describe("assertOwnership", () => {
    it("no lanza si el uid coincide", () => {
      const context = { uid: "uid-1", email: "a@b.c", role: Role.CUSTOMER, status: UserStatus.ACTIVE };
      expect(() => assertOwnership(context, "uid-1")).not.toThrow();
    });

    it("lanza 403 si el uid no coincide", () => {
      const context = { uid: "uid-1", email: "a@b.c", role: Role.CUSTOMER, status: UserStatus.ACTIVE };
      expect(() => assertOwnership(context, "uid-2")).toThrow();
      try {
        assertOwnership(context, "uid-2");
      } catch (error) {
        expect((error as { statusCode?: number }).statusCode).toBe(403);
      }
    });
  });
});