import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createFirestoreMock } from "@/test-utils/firestore-mock";
import {
  getAdminPending,
  PENDING_SCAN_LIMIT,
} from "./admin-pending-service";
import { getApplicationFunnel, FUNNEL_SCAN_LIMIT } from "./application-funnel-service";
import { ApplicationStatus, LoanStatus, PaymentStatus } from "@/server/types";

function dbWith(seeds: Record<string, Array<{ id: string; status: string }>>): Firestore {
  const { store, db } = createFirestoreMock();
  for (const [coleccion, filas] of Object.entries(seeds)) {
    for (const fila of filas) {
      store.seed(coleccion, fila.id, { status: fila.status });
    }
  }
  return db as Firestore;
}

const SOLICITUDES = [
  { id: "app-1", status: ApplicationStatus.SUBMITTED },
  { id: "app-2", status: ApplicationStatus.SUBMITTED },
  { id: "app-3", status: ApplicationStatus.UNDER_REVIEW },
  { id: "app-4", status: ApplicationStatus.APPROVED },
  { id: "app-5", status: ApplicationStatus.REJECTED },
  { id: "app-6", status: ApplicationStatus.DRAFT },
];

describe("getAdminPending", () => {
  it("cuenta solo lo que espera una decisión del admin y esconde los ceros", async () => {
    const db = dbWith({
      loan_applications: SOLICITUDES,
      payments: [{ id: "pay-1", status: PaymentStatus.PENDING }],
      loans: [{ id: "loan-1", status: LoanStatus.PENDING_DISBURSEMENT }],
    });

    const pending = await getAdminPending({ db });

    expect(pending.total).toBe(5);
    expect(pending.items.map((item) => item.id)).toEqual(["solicitudes", "pagos", "desembolsos"]);
    expect(pending.items[0].count).toBe(3);
    expect(pending.items[1].count).toBe(1);
    expect(pending.items[2].count).toBe(1);
  });

  it("cada cola enlaza a la sección donde se resuelve", async () => {
    const pending = await getAdminPending({
      db: dbWith({
        loan_applications: SOLICITUDES,
        payments: [{ id: "pay-1", status: PaymentStatus.PENDING }],
        loans: [{ id: "loan-1", status: LoanStatus.PENDING_DISBURSEMENT }],
      }),
    });

    expect(pending.items.map((item) => item.href)).toEqual([
      "/admin/loan-applications",
      "/admin/pagos",
      "/admin/prestamos",
    ]);
    for (const item of pending.items) {
      expect(item.description.length).toBeGreaterThan(0);
    }
  });

  it("no cuenta estados que no son cola (una solicitud aprobada no espera a nadie)", async () => {
    const db = dbWith({
      loan_applications: [
        { id: "app-aprobada", status: ApplicationStatus.APPROVED },
        { id: "app-rechazada", status: ApplicationStatus.REJECTED },
        { id: "app-borrador", status: ApplicationStatus.DRAFT },
      ],
      payments: [{ id: "pay-confirmado", status: PaymentStatus.CONFIRMED }],
      loans: [{ id: "loan-pagado", status: LoanStatus.PAID }],
    });

    const pending = await getAdminPending({ db });

    expect(pending.items).toEqual([]);
    expect(pending.total).toBe(0);
  });

  it("marca `truncated` cuando una cola supera el tope en vez de vender un total inventado", async () => {
    const db = dbWith({ loan_applications: [] });
    for (let i = 0; i < PENDING_SCAN_LIMIT; i += 1) {
      db.collection("loan_applications").doc(`bulk-${i}`).set({
        status: ApplicationStatus.SUBMITTED,
      });
    }

    const pending = await getAdminPending({ db });

    expect(pending.items[0].count).toBe(PENDING_SCAN_LIMIT);
    expect(pending.items[0].truncated).toBe(true);
  });
});

describe("getApplicationFunnel", () => {
  it("agrupa el embudo por estado con su etiqueta en español", async () => {
    const funnel = await getApplicationFunnel({
      db: dbWith({ loan_applications: SOLICITUDES }),
    });

    expect(funnel.total).toBe(6);
    expect(funnel.truncated).toBe(false);
    expect(funnel.byStatus).toEqual([
      { status: ApplicationStatus.DRAFT, label: "Borrador", count: 1 },
      { status: ApplicationStatus.SUBMITTED, label: "Presentada", count: 2 },
      { status: ApplicationStatus.UNDER_REVIEW, label: "En revisión", count: 1 },
      { status: ApplicationStatus.APPROVED, label: "Aprobada", count: 1 },
      { status: ApplicationStatus.REJECTED, label: "Rechazada", count: 1 },
    ]);
  });

  it("devuelve un embudo vacío y no un error cuando no hay solicitudes", async () => {
    const funnel = await getApplicationFunnel({ db: dbWith({ loan_applications: [] }) });

    expect(funnel.byStatus).toEqual([]);
    expect(funnel.total).toBe(0);
  });

  it("el estado vacío de la cartera no oculta las solicitudes: son colecciones distintas", async () => {
    const funnel = await getApplicationFunnel({
      db: dbWith({ loan_applications: SOLICITUDES, loans: [] }),
    });

    expect(funnel.total).toBe(6);
  });

  it("marca `truncated` cuando un estado supera el tope", async () => {
    const db = dbWith({ loan_applications: [] });
    for (let i = 0; i < FUNNEL_SCAN_LIMIT; i += 1) {
      db.collection("loan_applications").doc(`bulk-${i}`).set({
        status: ApplicationStatus.SUBMITTED,
      });
    }

    const funnel = await getApplicationFunnel({ db });

    expect(funnel.truncated).toBe(true);
  });
});