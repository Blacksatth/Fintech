import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { seedPaymentChannels } from "../src/services/payments/seed-payment-channels";
import { getActivePaymentChannel, listActivePaymentChannels } from "../src/services/payments/payment-channel-service";
import { buildPaymentChannelDoc, paymentChannelDocSchema, PaymentChannelType } from "../src/server/payment-doc";

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID requerida para tests de integracion. Revisa .env");
}
if (getApps().length === 0) {
  initializeApp({ projectId });
}

const db = getFirestore();

/** Los cuatro canales que siembra `npm run seed`, en el orden de la spec §11. */
const CHANNEL_IDS = ["BANK_TRANSFER", "NEQUI", "QR", "BREB"] as const;

const createdByThisRun = new Set<string>();

function trackCreated(channels: string[]): void {
  for (const path of channels) {
    createdByThisRun.add(path.split("/")[1]);
  }
}

/**
 * **Siempre** por esta vía, nunca `seedPaymentChannels(db)` a pelo.
 *
 * El seed usa ids fijos (`NEQUI`, `QR`…), así que sus ids no parecen "de test" y
 * `check-test-leftovers` no los puede delatar: si un test siembra y no registra lo que creó, deja
 * cuatro canales de demo en el proyecto real y nadie se entera. Es la fuga que F9-2 encontró con
 * `loan_applications`, en otra colección.
 */
async function seedTracked() {
  const result = await seedPaymentChannels(db);
  trackCreated(result.channels);
  return result;
}

async function cleanTrackedDocs(): Promise<string[]> {
  const failures: string[] = [];
  for (const id of createdByThisRun) {
    try {
      await db.collection("payment_channels").doc(id).delete();
    } catch (err) {
      failures.push(`payment_channels/${id}: ${(err as Error).message}`);
    }
  }
  createdByThisRun.clear();
  return failures;
}

afterEach(async () => {
  const failures = await cleanTrackedDocs();
  if (failures.length > 0) throw new Error(`limpieza incompleta: ${failures.join("; ")}`);
});

afterAll(async () => {
  const failures = await cleanTrackedDocs();
  if (failures.length > 0) throw new Error(`limpieza incompleta: ${failures.join("; ")}`);
});

describe("canales de pago contra Firestore real", () => {
  it("el seed deja los cuatro canales de demo legibles y con la forma del spec", async () => {
    const result = await seedTracked();
    const creadosAqui = new Set(result.channels.map((path) => path.split("/")[1]));

    for (const id of CHANNEL_IDS) {
      const snap = await db.collection("payment_channels").doc(id).get();
      expect(snap.exists, `falta payment_channels/${id}`).toBe(true);

      // El doc real tiene que parsear contra el schema: si el seed escribe algo que el schema no
      // acepta, la UI de canales y los pagos se rompen en producción, no en el test.
      const parsed = paymentChannelDocSchema.parse(snap.data());
      expect(parsed.type).toBe(id);
      expect(parsed.isActive).toBe(true);
      expect(parsed.instructionsText.length).toBeGreaterThan(10);

      // Los marcadores de demo solo se exigen en los canales que escribió ESTA corrida: si el
      // proyecto ya tiene los canales de un admin (datos reales, sin `demo`), el test debe pasar
      // igual. Un proyecto bien configurado no puede invalidarse por correr el test.
      if (creadosAqui.has(id)) {
        expect(parsed.meta["legalReview"]).toBe("PENDING_LEGAL_REVIEW");
        expect(parsed.meta["demo"]).toBe(true);
      }
    }
  });

  it("el seed es idempotente: la segunda ejecución no crea nada nuevo", async () => {
    await seedTracked();

    const second = await seedPaymentChannels(db);

    expect(second.channelsCreated).toBe(0);
    expect(second.channels).toEqual([]);
  });

  it("no sobrescribe un canal ya existente (los datos del admin no se pierden)", async () => {
    await seedTracked();

    const id = `CANAL_TEST_${randomUUID().slice(0, 8).toUpperCase()}`;
    const ref = db.collection("payment_channels").doc(id);
    const instrucciones = "Instrucciones reales ya revisadas por la cooperativa.";
    await ref.set(
      buildPaymentChannelDoc(
        {
          name: "Canal de prueba",
          type: PaymentChannelType.NEQUI,
          instructionsText: instrucciones,
          meta: { nequiNumber: "300 111 2222" },
        },
        new Date(),
      ),
    );
    createdByThisRun.add(id);

    const result = await seedPaymentChannels(db);

    expect(result.channels).not.toContain(`payment_channels/${id}`);
    const snap = await ref.get();
    expect(snap.data()?.instructionsText).toBe(instrucciones);
  });

  it("la lectura trae los canales activos y oculta los desactivados", async () => {
    await seedTracked();

    const activos = await listActivePaymentChannels({ db });
    const ids = activos.map((c) => c.id);
    for (const id of CHANNEL_IDS) {
      expect(ids, `payment_channels/${id} no aparece en la lectura`).toContain(id);
    }

    const id = `CANAL_TEST_${randomUUID().slice(0, 8).toUpperCase()}`;
    const ref = db.collection("payment_channels").doc(id);
    await ref.set(
      buildPaymentChannelDoc(
        {
          name: "Canal apagado de prueba",
          type: PaymentChannelType.QR,
          instructionsText: "Este canal existe solo para comprobar que se puede apagar.",
          meta: {},
          isActive: false,
        },
        new Date(),
      ),
    );
    createdByThisRun.add(id);

    expect(await getActivePaymentChannel({ db }, id)).toBeNull();
    const trasApagar = await listActivePaymentChannels({ db });
    expect(trasApagar.map((c) => c.id)).not.toContain(id);

    await ref.update({ isActive: true });
    const encendido = await getActivePaymentChannel({ db }, id);
    expect(encendido?.id).toBe(id);
    expect(encendido?.name).toBe("Canal apagado de prueba");
  });

  it("un canal inexistente se lee como null (no como error)", async () => {
    expect(await getActivePaymentChannel({ db }, `CANAL_TEST_${randomUUID()}`)).toBeNull();
  });
});
