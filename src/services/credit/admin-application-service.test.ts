import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { listApplicationsForAdmin } from "./admin-application-service";
import { createFirestoreMock } from "@/test-utils/firestore-mock";
import { ApplicationStatus, TermFrequency } from "@/server/types";

const T0 = new Date("2026-09-01T12:00:00.000Z");
const T1 = new Date("2026-09-05T12:00:00.000Z");
const T2 = new Date("2026-09-09T12:00:00.000Z");

function applicationDoc(number: string, status: ApplicationStatus, createdAt: Date) {
  return {
    applicationNumber: number,
    userId: `uid-${number}`,
    productId: "MICRO_BASICO",
    requestedAmountPesos: 50_000,
    termInstallments: 4,
    termFrequency: TermFrequency.BIWEEKLY,
    status,
    createdAt,
    updatedAt: createdAt,
  };
}

function setup() {
  const { store, db } = createFirestoreMock();
  store.seed("loan_applications", "app-a", applicationDoc("APP-A", ApplicationStatus.SUBMITTED, T1));
  store.seed("loan_applications", "app-b", applicationDoc("APP-B", ApplicationStatus.APPROVED, T2));
  store.seed("loan_applications", "app-c", applicationDoc("APP-C", ApplicationStatus.SUBMITTED, T0));
  return { db: db as Firestore, store };
}

describe("listApplicationsForAdmin", () => {
  it("sin filtro trae todas ordenadas por creación descendente", async () => {
    const { db } = setup();

    const resultado = await listApplicationsForAdmin({ db });

    expect(resultado.map((a) => a.id)).toEqual(["app-b", "app-a", "app-c"]);
  });

  it("con filtro trae solo ese estado, tambien ordenado", async () => {
    const { db } = setup();

    const resultado = await listApplicationsForAdmin({ db }, { status: ApplicationStatus.SUBMITTED });

    expect(resultado.map((a) => a.id)).toEqual(["app-a", "app-c"]);
  });

  it("desempata por id para que el orden sea estable", async () => {
    const { store, db } = setup();
    store.seed("loan_applications", "app-d", applicationDoc("APP-D", ApplicationStatus.SUBMITTED, T1));

    const resultado = await listApplicationsForAdmin({ db }, { status: ApplicationStatus.SUBMITTED });

    expect(resultado.map((a) => a.id)).toEqual(["app-a", "app-d", "app-c"]);
  });

  /**
   * Regresión real: `where(status) + orderBy(createdAt)` exige el índice compuesto
   * `[status, createdAt desc]`, que está declarado en `firestore.indexes.json` pero no se puede
   * desplegar sin `roles/datastore.owner`. En el proyecto real `/admin/loan-applications?estado=…`
   * daba 500 con `FAILED_PRECONDITION: The query requires an index`. Con filtro, la query debe
   * ser de igualdad pura y el orden se resuelve en memoria.
   */
  it("nunca combina where con orderBy (si no, exige indice compuesto no desplegado)", async () => {
    const { db, store } = setup();

    await listApplicationsForAdmin({ db });
    await listApplicationsForAdmin({ db }, { status: ApplicationStatus.SUBMITTED });
    await listApplicationsForAdmin({ db }, { status: ApplicationStatus.APPROVED });

    expect(store.queries.length).toBe(3);
    for (const query of store.queries) {
      expect(
        query.filters.length > 0 && query.order !== null,
        `where + orderBy en ${query.collection}: ${JSON.stringify(query)}`,
      ).toBe(false);
    }
  });

  it("sin filtro sí puede usar orderBy (índice simple de un campo)", async () => {
    const { db, store } = setup();

    await listApplicationsForAdmin({ db });

    expect(store.queries[0].filters).toHaveLength(0);
    expect(store.queries[0].order).toEqual({ field: "createdAt", direction: "desc" });
  });
});
