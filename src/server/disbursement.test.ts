import { describe, expect, it } from "vitest";
import {
  ManualDisbursementProvider,
  rescheduleDueDates,
  type DisbursementInitiation,
} from "./disbursement";
import type { DisbursementDoc, LoanInstallmentDoc, LoanPricingSnapshot } from "@/server/credit-doc";
import { TermFrequency } from "@/server/types";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const provider = new ManualDisbursementProvider();

const initiation: DisbursementInitiation = {
  loanId: "loan-1",
  initiatedBy: "admin-1",
  initiatedAt: NOW,
  idempotencyKey: "key-1",
};

function initiated(overrides: Partial<DisbursementDoc> = {}): DisbursementDoc {
  return { ...provider.initiate(null, initiation), ...overrides } as DisbursementDoc;
}

function installment(n: number, due: Date): LoanInstallmentDoc {
  return {
    loanId: "loan-1",
    installmentNumber: n,
    dueDate: due,
    principalPesos: 12_500,
    interestPesos: 400,
    feePesos: 625,
    totalPesos: 13_525,
    paidPesos: 0,
    status: "PENDING",
  };
}

describe("ManualDisbursementProvider.initiate", () => {
  it("crea el doc en INITIATED con el provider manual", () => {
    const doc = provider.initiate(null, initiation);

    expect(doc.provider).toBe("manual");
    expect(doc.status).toBe("INITIATED");
    expect(doc.loanId).toBe("loan-1");
    expect(doc.initiatedBy).toBe("admin-1");
    expect(doc.idempotencyKey).toBe("key-1");
    expect(doc.confirmedAt).toBeUndefined();
  });

  it("registra la referencia si viene en el inicio", () => {
    const doc = provider.initiate(null, { ...initiation, reference: "  REF-123  " });

    expect(doc.reference).toBe("REF-123");
  });

  it("no deja iniciar dos veces el mismo desembolso", () => {
    expect(() => provider.initiate(initiated(), { ...initiation, idempotencyKey: "key-2" })).toThrow(
      /ya tiene un desembolso/,
    );
  });

  it("no deja iniciar sobre un desembolso confirmado", () => {
    const confirmado = provider.confirm(initiated({ reference: "REF-1" }), {
      reference: "REF-1",
      confirmedBy: "admin-1",
      confirmedAt: NOW,
    });

    expect(() => provider.initiate(confirmado, initiation)).toThrow(/ya tiene un desembolso/);
  });
});

describe("ManualDisbursementProvider.confirm", () => {
  it("confirma con referencia y deja constancia de quién y cuándo", () => {
    const doc = provider.confirm(initiated(), {
      reference: "REF-9",
      confirmedBy: "admin-2",
      confirmedAt: NOW,
    });

    expect(doc.status).toBe("CONFIRMED");
    expect(doc.reference).toBe("REF-9");
    expect(doc.confirmedBy).toBe("admin-2");
    expect(doc.confirmedAt).toBe(NOW);
  });

  it("usa la referencia registrada al iniciar si la confirmación no trae otra", () => {
    const doc = provider.confirm(initiated({ reference: "REF-INICIO" }), {
      confirmedBy: "admin-2",
      confirmedAt: NOW,
    });

    expect(doc.reference).toBe("REF-INICIO");
  });

  it("exige referencia: sin ella no se puede confirmar (nunca automático)", () => {
    expect(() =>
      provider.confirm(initiated(), { confirmedBy: "admin-2", confirmedAt: NOW }),
    ).toThrow(/referencia/i);
  });

  it("exige una confirmación humana identificable", () => {
    expect(() =>
      provider.confirm(initiated({ reference: "REF-1" }), {
        reference: "REF-1",
        confirmedBy: "   ",
        confirmedAt: NOW,
      }),
    ).toThrow(/confirm/i);
  });

  it("no confirma dos veces", () => {
    const confirmado = provider.confirm(initiated({ reference: "REF-1" }), {
      reference: "REF-1",
      confirmedBy: "admin-2",
      confirmedAt: NOW,
    });

    expect(() =>
      provider.confirm(confirmado, { reference: "REF-1", confirmedBy: "admin-3", confirmedAt: NOW }),
    ).toThrow(/confirmado/);
  });
});

describe("rescheduleDueDates", () => {
  const pricing: LoanPricingSnapshot = {
    annualRateBps: 2_400,
    effectiveFeeBps: 500,
    rateVersion: 1,
    termInstallments: 3,
    termFrequency: TermFrequency.MONTHLY,
  };

  it("mueve los vencimientos a partir de la fecha real de desembolso", () => {
    const actuales = [
      installment(1, new Date("2026-03-24T00:00:00.000Z")),
      installment(2, new Date("2026-04-07T00:00:00.000Z")),
      installment(3, new Date("2026-04-21T00:00:00.000Z")),
    ];

    const nuevas = rescheduleDueDates(actuales, new Date("2026-04-01T00:00:00.000Z"), pricing);

    expect(nuevas).toEqual([
      { installmentNumber: 1, dueDate: new Date("2026-05-01T00:00:00.000Z") },
      { installmentNumber: 2, dueDate: new Date("2026-06-01T00:00:00.000Z") },
      { installmentNumber: 3, dueDate: new Date("2026-07-01T00:00:00.000Z") },
    ]);
  });

  it("no toca los importes: devuelve solo installmentNumber y dueDate", () => {
    const actuales = [
      installment(1, new Date("2026-03-24T00:00:00.000Z")),
      installment(2, new Date("2026-04-07T00:00:00.000Z")),
      installment(3, new Date("2026-04-21T00:00:00.000Z")),
    ];

    const nuevas = rescheduleDueDates(actuales, new Date("2026-04-01T00:00:00.000Z"), pricing);

    expect(nuevas).toHaveLength(3);
    for (const nueva of nuevas) {
      expect(Object.keys(nueva).sort()).toEqual(["dueDate", "installmentNumber"]);
    }
  });

  it("empareja por numero de cuota, no por posicion, y sale ordenado", () => {
    const desordenadas = [
      installment(3, new Date("2026-04-21T00:00:00.000Z")),
      installment(1, new Date("2026-03-24T00:00:00.000Z")),
      installment(2, new Date("2026-04-07T00:00:00.000Z")),
    ];

    const nuevas = rescheduleDueDates(desordenadas, new Date("2026-04-01T00:00:00.000Z"), pricing);

    expect(nuevas).toEqual([
      { installmentNumber: 1, dueDate: new Date("2026-05-01T00:00:00.000Z") },
      { installmentNumber: 2, dueDate: new Date("2026-06-01T00:00:00.000Z") },
      { installmentNumber: 3, dueDate: new Date("2026-07-01T00:00:00.000Z") },
    ]);
  });

  it("falla si el numero de cuotas no coincide con el plazo del snapshot", () => {
    const actuales = [installment(1, new Date("2026-03-24T00:00:00.000Z"))];

    expect(() => rescheduleDueDates(actuales, new Date("2026-04-01T00:00:00.000Z"), pricing)).toThrow(
      /3 cuotas/,
    );
  });

  it("falla si las cuotas no estan numeradas de 1 a N (datos inconsistentes)", () => {
    const actuales = [
      installment(1, new Date("2026-03-24T00:00:00.000Z")),
      installment(2, new Date("2026-04-07T00:00:00.000Z")),
      installment(4, new Date("2026-04-21T00:00:00.000Z")),
    ];

    expect(() => rescheduleDueDates(actuales, new Date("2026-04-01T00:00:00.000Z"), pricing)).toThrow(
      /numeradas de 1 a N/,
    );
  });

  it("falla si falta el snapshot de pricing (prestamo anterior a F9)", () => {
    const actuales = [
      installment(1, new Date("2026-03-24T00:00:00.000Z")),
      installment(2, new Date("2026-04-07T00:00:00.000Z")),
      installment(3, new Date("2026-04-21T00:00:00.000Z")),
    ];

    expect(() =>
      rescheduleDueDates(actuales, new Date("2026-04-01T00:00:00.000Z"), undefined),
    ).toThrow(/pricing/i);
  });

  it("no recalcula una cuota ya pagada: su vencimiento es un hecho consumado", () => {
    const actuales = [
      { ...installment(1, new Date("2026-03-24T00:00:00.000Z")), status: "PAID" as const },
      installment(2, new Date("2026-04-07T00:00:00.000Z")),
      installment(3, new Date("2026-04-21T00:00:00.000Z")),
    ];

    const nuevas = rescheduleDueDates(actuales, new Date("2026-04-01T00:00:00.000Z"), pricing);

    expect(nuevas.map((c) => c.installmentNumber)).toEqual([2, 3]);
    expect(nuevas[0].dueDate).toEqual(new Date("2026-06-01T00:00:00.000Z"));
  });
});
