import { describe, expect, it } from "vitest";
import { createFirestoreMock } from "@/test-utils/firestore-mock";
import { seedPaymentChannels } from "./seed-payment-channels";
import { listActivePaymentChannels, getActivePaymentChannel } from "./payment-channel-service";
import { PaymentChannelType } from "@/server/payment-doc";

function setup() {
  return createFirestoreMock();
}

describe("seedPaymentChannels", () => {
  it("crea los cuatro canales de demo", async () => {
    const { store, db } = setup();

    const result = await seedPaymentChannels(db);

    expect(result.channelsCreated).toBe(4);
    expect(result.channels).toEqual([
      "payment_channels/BANK_TRANSFER",
      "payment_channels/NEQUI",
      "payment_channels/QR",
      "payment_channels/BREB",
    ]);
    expect(store.ids("payment_channels")).toHaveLength(4);

    const nequi = store.read("payment_channels", "NEQUI")!;
    expect(nequi["name"]).toBe("Nequi");
    expect(nequi["type"]).toBe(PaymentChannelType.NEQUI);
    expect(nequi["isActive"]).toBe(true);
    expect(String(nequi["instructionsText"]).length).toBeGreaterThan(10);
  });

  it("marca los datos como demo y pendientes de revisión legal", async () => {
    const { store, db } = setup();

    await seedPaymentChannels(db);

    for (const id of store.ids("payment_channels")) {
      const meta = store.read("payment_channels", id)!["meta"] as Record<string, unknown>;
      expect(meta["demo"]).toBe(true);
      expect(meta["legalReview"]).toBe("PENDING_LEGAL_REVIEW");
      expect(String(store.read("payment_channels", id)!["instructionsText"])).toContain("DEMOSTRACIÓN");
    }
  });

  it("es idempotente: la segunda ejecución no crea ni duplica", async () => {
    const { store, db } = setup();
    await seedPaymentChannels(db);

    const second = await seedPaymentChannels(db);

    expect(second.channelsCreated).toBe(0);
    expect(second.channels).toEqual([]);
    expect(store.ids("payment_channels")).toHaveLength(4);
  });

  /**
   * Un canal existente es del admin: sus datos reales no se pueden perder por reejecutar el seed.
   */
  it("no sobrescribe un canal ya editado por el admin", async () => {
    const { store, db } = setup();
    store.seed("payment_channels", "NEQUI", {
      name: "Nequi",
      type: PaymentChannelType.NEQUI,
      instructionsText: "Paga al 300 111 2222 (datos reales ya verificados por la cooperativa).",
      meta: { nequiNumber: "300 111 2222" },
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await seedPaymentChannels(db);

    expect(result.channelsCreated).toBe(3);
    expect(store.read("payment_channels", "NEQUI")!["meta"]).toEqual({ nequiNumber: "300 111 2222" });
  });

  it("crea solo los canales que faltan", async () => {
    const { store, db } = setup();
    store.seed("payment_channels", "QR", {
      name: "Código QR",
      type: PaymentChannelType.QR,
      instructionsText: "Escanea el QR real que subió el admin.",
      meta: {},
      isActive: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await seedPaymentChannels(db);

    expect(result.channelsCreated).toBe(3);
    expect(result.channels).not.toContain("payment_channels/QR");
    expect(store.read("payment_channels", "QR")!["isActive"]).toBe(false);
  });
});

describe("listActivePaymentChannels", () => {
  it("devuelve los canales activos ordenados por nombre, con desempate estable por id", async () => {
    const { store, db } = setup();
    await seedPaymentChannels(db);
    store.seed("payment_channels", "Z_EXTRA", {
      name: "Caja (oficina)",
      type: PaymentChannelType.BANK_TRANSFER,
      instructionsText: "Paga en la oficina de atención al cliente.",
      meta: {},
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const canales = await listActivePaymentChannels({ db });

    // Orden de colación española: "Bre-B" < "Caja" < "Código" < "Nequi" < "Transferencia".
    expect(canales.map((c) => c.name)).toEqual([
      "Bre-B (ventanilla)",
      "Caja (oficina)",
      "Código QR",
      "Nequi",
      "Transferencia bancaria",
    ]);
  });

  it("excluye los canales desactivados por el admin", async () => {
    const { store, db } = setup();
    await seedPaymentChannels(db);
    const nequi = store.read("payment_channels", "NEQUI")!;
    store.seed("payment_channels", "NEQUI", { ...nequi, isActive: false });

    const canales = await listActivePaymentChannels({ db });

    expect(canales.map((c) => c.id)).not.toContain("NEQUI");
    expect(canales).toHaveLength(3);
  });

  it("devuelve id junto con el documento", async () => {
    const { db } = setup();
    await seedPaymentChannels(db);

    const [primero] = await listActivePaymentChannels({ db });

    expect(primero.id).toBe("BREB");
  });

  /**
   * Regresión real de F9-2: `where(isActive) + orderBy(name)` exige un índice compuesto
   * `[isActive, name]` que no se puede desplegar en este proyecto. La config es de cuatro docs, así
   * que se filtra y ordena en memoria.
   */
  it("nunca combina where con orderBy (si no, exige indice compuesto no desplegado)", async () => {
    const { store, db } = setup();
    await seedPaymentChannels(db);
    store.queries.length = 0;

    await listActivePaymentChannels({ db });

    for (const query of store.queries) {
      expect(
        query.filters.length > 0 && query.order !== null,
        `where + orderBy en ${query.collection}: ${JSON.stringify(query)}`,
      ).toBe(false);
    }
  });
});

describe("getActivePaymentChannel", () => {
  it("devuelve el canal activo", async () => {
    const { db } = setup();
    await seedPaymentChannels(db);

    const canal = await getActivePaymentChannel({ db }, PaymentChannelType.BANK_TRANSFER);

    expect(canal?.id).toBe("BANK_TRANSFER");
    expect(canal?.type).toBe(PaymentChannelType.BANK_TRANSFER);
  });

  it("devuelve null si el canal no existe", async () => {
    const { db } = setup();
    await seedPaymentChannels(db);

    expect(await getActivePaymentChannel({ db }, "PAYPAL")).toBeNull();
  });

  it("devuelve null si el canal está inactivo (un canal cerrado no se ofrece)", async () => {
    const { store, db } = setup();
    await seedPaymentChannels(db);
    const nequi = store.read("payment_channels", "NEQUI")!;
    store.seed("payment_channels", "NEQUI", { ...nequi, isActive: false });

    expect(await getActivePaymentChannel({ db }, "NEQUI")).toBeNull();
  });
});
