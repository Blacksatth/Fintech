import { describe, expect, it } from "vitest";
import { createInAppProvider, notifyUser } from "./notification-service";
import { createFirestoreMock } from "@/test-utils/firestore-mock";
import { NotificationType } from "@/server/notification-doc";

const HOY = new Date("2026-03-24T12:00:00.000Z");

function mensaje(overrides: { userId?: string; refKey?: string } = {}) {
  return {
    userId: overrides.userId ?? "uid-1",
    type: NotificationType.INSTALLMENT_OVERDUE,
    title: "Tienes una cuota vencida",
    body: "La cuota 1 de $26.828 venció el 01/03/2026 (23 días de atraso).",
    refKey: overrides.refKey ?? "loan-a_1",
    payload: { loanId: "loan-a" },
  };
}

function setup() {
  const { store, db } = createFirestoreMock();
  return { db, store, deps: { db, notifyProviders: [createInAppProvider({ db })] } };
}

describe("notifyUser", () => {
  it("guarda el aviso en la bandeja con el id determinista", async () => {
    const { deps, store } = setup();

    const result = await notifyUser(deps, mensaje(), HOY);

    expect(result).toEqual({ id: "uid-1_INSTALLMENT_OVERDUE_loan-a_1", created: true, providers: ["in-app"] });
    const doc = store.read("notifications", "uid-1_INSTALLMENT_OVERDUE_loan-a_1");
    expect(doc?.["userId"]).toBe("uid-1");
    expect(doc?.["type"]).toBe(NotificationType.INSTALLMENT_OVERDUE);
    expect(doc?.["status"]).toBe("SENT");
    expect(doc?.["sentAt"]).toBe(HOY);
    // El `refKey` viaja en el payload para que la bandeja pueda enlazar al préstamo y a la cuota.
    expect(doc?.["payload"]).toMatchObject({ refKey: "loan-a_1", loanId: "loan-a" });
  });

  it("avisar dos veces de lo mismo no duplica el aviso", async () => {
    const { deps, store } = setup();

    const primero = await notifyUser(deps, mensaje(), HOY);
    const segundo = await notifyUser(deps, mensaje(), new Date("2026-03-25T12:00:00.000Z"));

    expect(primero.created).toBe(true);
    expect(segundo.created).toBe(false);
    expect(store.list("notifications")).toHaveLength(1);
    // El doc existente no se pisa: la fecha del primer aviso es la que se ve en la bandeja.
    expect(store.read("notifications", "uid-1_INSTALLMENT_OVERDUE_loan-a_1")?.["createdAt"]).toBe(HOY);
  });

  it("otra cuota del mismo préstamo sí recibe su propio aviso", async () => {
    const { deps, store } = setup();

    await notifyUser(deps, mensaje({ refKey: "loan-a_1" }), HOY);
    await notifyUser(deps, mensaje({ refKey: "loan-a_2" }), HOY);

    expect(store.ids("notifications")).toEqual(["uid-1_INSTALLMENT_OVERDUE_loan-a_1", "uid-1_INSTALLMENT_OVERDUE_loan-a_2"]);
  });

  it("corta en el primer proveedor que entrega: el log no se ejecuta si la bandeja ya tenía el aviso", async () => {
    const { deps } = setup();
    const visto: string[] = [];
    const log = {
      name: "log",
      deliver: async () => {
        visto.push("log");
        return false;
      },
    };
    const primero = createInAppProvider({ db: deps.db });

    await notifyUser(deps, mensaje(), HOY, [primero, log]);
    await notifyUser(deps, mensaje(), HOY, [primero, log]);

    expect(visto).toHaveLength(1);
  });
});
