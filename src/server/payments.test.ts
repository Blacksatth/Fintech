import { describe, expect, it } from "vitest";
import {
  PaymentError,
  assertInstallmentLockedByPayment,
  assertLoanAcceptsPayments,
  assertPayableInstallment,
  confirmPaymentState,
  effectConfirmInstallment,
  effectRejectInstallment,
  effectReverseInstallment,
  formatPaymentNumber,
  installmentBalance,
  normalizePaymentReference,
  parsePaymentNumberSequence,
  rejectPaymentState,
  reversePaymentState,
} from "./payments";
import { buildPaymentDoc, type PaymentDoc } from "./payment-doc";
import { Currency, InstallmentStatus, LoanStatus, PaymentStatus } from "./types";

const YEAR = 2026;
const LOAN = { loanNumber: "LOAN-0001", status: LoanStatus.DISBURSED };

function cuota(overrides: Partial<Parameters<typeof assertPayableInstallment>[0]> = {}) {
  return {
    loanId: "loan-1",
    installmentNumber: 2,
    status: InstallmentStatus.PENDING,
    totalPesos: 13_414,
    paidPesos: 0,
    ...overrides,
  };
}

const TARGET = { loanId: "loan-1", installmentId: "loan-1_2" };

describe("installmentBalance", () => {
  it("es el saldo de la cuota, no el total ni lo pagado", () => {
    expect(installmentBalance({ totalPesos: 13_414, paidPesos: 0 })).toBe(13_414);
    expect(installmentBalance({ totalPesos: 13_414, paidPesos: 4_000 })).toBe(9_414);
  });

  it("rechaza importes que no son enteros seguros en vez de redondear", () => {
    expect(() => installmentBalance({ totalPesos: 13_414.5, paidPesos: 0 })).toThrow(RangeError);
  });
});

describe("formatPaymentNumber", () => {
  it("numera por año con 4 dígitos y empieza en 1", () => {
    expect(formatPaymentNumber(YEAR, 1)).toBe("PAY-2026-0001");
    expect(formatPaymentNumber(YEAR, 42)).toBe("PAY-2026-0042");
    expect(formatPaymentNumber(YEAR, 9_999)).toBe("PAY-2026-9999");
  });

  it("no se sale del formato si se agota el año", () => {
    expect(() => formatPaymentNumber(YEAR, 10_000)).toThrow(PaymentError);
    expect(() => formatPaymentNumber(YEAR, 0)).toThrow(PaymentError);
    expect(() => formatPaymentNumber(YEAR, 1.5)).toThrow(PaymentError);
  });

  it("rechaza un año imposible", () => {
    expect(() => formatPaymentNumber(1999, 1)).toThrow(/Año inválido/);
  });

  it("el round-trip con el parser conserva el consecutivo", () => {
    expect(parsePaymentNumberSequence("PAY-2026-0042", YEAR)).toBe(42);
  });

  it("el parser falla en voz alta ante un número corrupto en vez de saltarse uno", () => {
    expect(() => parsePaymentNumberSequence("PAY-2026-42", YEAR)).toThrow(/numeración está corrupta/);
    expect(() => parsePaymentNumberSequence("PAY-2025-0001", YEAR)).toThrow(PaymentError);
  });
});

describe("normalizePaymentReference", () => {
  it("es opcional: vacío o ausente se guardan como undefined", () => {
    expect(normalizePaymentReference(undefined)).toBeUndefined();
    expect(normalizePaymentReference("   ")).toBeUndefined();
  });

  it("recorta y valida el largo", () => {
    expect(normalizePaymentReference("  REF-99  ")).toBe("REF-99");
    expect(() => normalizePaymentReference("x".repeat(121))).toThrow(/no puede superar/);
  });
});

describe("assertLoanAcceptsPayments", () => {
  it("acepta un préstamo disbursado y uno en mora", () => {
    expect(() => assertLoanAcceptsPayments(LOAN)).not.toThrow();
    expect(() => assertLoanAcceptsPayments({ ...LOAN, status: LoanStatus.DEFAULTED })).not.toThrow();
  });

  it("rechaza un préstamo que todavía no salió dinero", () => {
    expect(() => assertLoanAcceptsPayments({ ...LOAN, status: LoanStatus.PENDING_DISBURSEMENT })).toThrow(
      /aún no está desembolsado/,
    );
  });

  it("rechaza un préstamo saldado o condonado", () => {
    expect(() => assertLoanAcceptsPayments({ ...LOAN, status: LoanStatus.PAID })).toThrow(/saldado/);
    expect(() => assertLoanAcceptsPayments({ ...LOAN, status: LoanStatus.WRITTEN_OFF })).toThrow(
      /no admite pagos/,
    );
  });

  it("el conflicto es 409", () => {
    try {
      assertLoanAcceptsPayments({ ...LOAN, status: LoanStatus.PAID });
      expect.unreachable("debería lanzar");
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentError);
      expect((error as PaymentError).statusCode).toBe(409);
    }
  });
});

describe("assertPayableInstallment", () => {
  it("devuelve el saldo pendiente: ese y solo ese es el importe del pago", () => {
    expect(assertPayableInstallment(cuota(), TARGET)).toBe(13_414);
    expect(assertPayableInstallment(cuota({ paidPesos: 4_000 }), TARGET)).toBe(9_414);
  });

  it("404 si la cuota es de otro préstamo o el id no corresponde", () => {
    try {
      assertPayableInstallment(cuota({ loanId: "loan-otro" }), TARGET);
      expect.unreachable("debería lanzar");
    } catch (error) {
      expect((error as PaymentError).statusCode).toBe(404);
    }
    expect(() => assertPayableInstallment(cuota(), { ...TARGET, installmentId: "loan-1_3" })).toThrow(
      /Cuota no encontrada/,
    );
  });

  it("no deja pagar una cuota ya pagada", () => {
    expect(() =>
      assertPayableInstallment(
        cuota({ status: InstallmentStatus.PAID, paidPesos: 13_414 }),
        TARGET,
      ),
    ).toThrow(/ya está pagada/);
  });

  it("no deja un segundo pago PENDING sobre la misma cuota", () => {
    expect(() =>
      assertPayableInstallment(cuota({ pendingPaymentId: "PAY-2026-0007" }), TARGET),
    ).toThrow(/pendiente de confirmación/);
  });

  it("no propaga un saldo cero o negativo si los datos no cuadran", () => {
    expect(() => assertPayableInstallment(cuota({ totalPesos: 10_000, paidPesos: 10_000 }), TARGET)).toThrow(
      /no tiene saldo pendiente/,
    );
    expect(() => assertPayableInstallment(cuota({ paidPesos: 20_000 }), TARGET)).toThrow(
      /no tiene saldo pendiente/,
    );
  });
});

function pago(overrides: Partial<BuildPaymentInput> = {}): PaymentDoc {
  return buildPaymentDoc(
    {
      paymentNumber: "PAY-2026-0001",
      userId: "uid-1",
      loanId: "loan-1",
      installmentId: "loan-1_1",
      amountPesos: 13_414,
      currency: Currency.COP,
      channel: "BANK_TRANSFER",
      idempotencyKey: "k-1",
      reference: "REF-9",
      ...overrides,
    },
    new Date("2026-03-24T00:00:00.000Z"),
  );
}

interface BuildPaymentInput {
  paymentNumber: string;
  userId: string;
  loanId: string;
  installmentId: string;
  amountPesos: number;
  currency: Currency;
  channel: string;
  idempotencyKey: string;
  reference?: string;
}

const NOW = new Date("2026-03-24T12:00:00.000Z");
const CUOTA_PENDIENTE = {
  loanId: "loan-1",
  installmentNumber: 1,
  status: InstallmentStatus.PENDING,
  totalPesos: 13_414,
  paidPesos: 0,
  pendingPaymentId: "PAY-2026-0001",
};

describe("confirmPaymentState", () => {
  it("PENDING -> CONFIRMED con quién, cuándo y nota opcional", () => {
    const resultado = confirmPaymentState(pago(), { confirmedBy: "admin-1", confirmedAt: NOW, adminNote: "Ok" });
    expect(resultado.status).toBe(PaymentStatus.CONFIRMED);
    expect(resultado.confirmedBy).toBe("admin-1");
    expect(resultado.confirmedAt).toBe(NOW);
    expect(resultado.adminNote).toBe("Ok");
    expect(resultado.updatedAt).toBe(NOW);
  });

  it("solo se confirma desde PENDING: el estado terminal es único", () => {
    const confirmado = confirmPaymentState(pago(), { confirmedBy: "admin-1", confirmedAt: NOW });
    expect(() =>
      confirmPaymentState(confirmado, { confirmedBy: "admin-1", confirmedAt: NOW }),
    ).toThrow(/no se puede confirmar/);
    const rechazado = rejectPaymentState(pago(), {
      rejectedBy: "admin-1",
      rejectedAt: NOW,
      reason: "Referencia no existe",
    });
    expect(() =>
      confirmPaymentState(rechazado, { confirmedBy: "admin-1", confirmedAt: NOW }),
    ).toThrow(PaymentError);
  });

  it("exige actor identificado", () => {
    expect(() =>
      confirmPaymentState(pago(), { confirmedBy: "  ", confirmedAt: NOW }),
    ).toThrow(/Falta la identificación/);
  });
});

describe("rejectPaymentState", () => {
  it("PENDING -> REJECTED con motivo y actor", () => {
    const resultado = rejectPaymentState(pago(), {
      rejectedBy: "admin-1",
      rejectedAt: NOW,
      reason: "  Referencia no existe  ",
    });
    expect(resultado.status).toBe(PaymentStatus.REJECTED);
    expect(resultado.rejectedBy).toBe("admin-1");
    expect(resultado.rejectedAt).toBe(NOW);
    expect(resultado.reason).toBe("Referencia no existe");
  });

  it("exige un motivo (400) y con largo máximo", () => {
    expect(() =>
      rejectPaymentState(pago(), { rejectedBy: "admin-1", rejectedAt: NOW, reason: "   " }),
    ).toThrow(/sin explicar/);
    expect(() =>
      rejectPaymentState(pago(), {
        rejectedBy: "admin-1",
        rejectedAt: NOW,
        reason: "x".repeat(501),
      }),
    ).toThrow(PaymentError);
  });

  it("no se rechaza un pago ya resuelto", () => {
    const confirmado = confirmPaymentState(pago(), { confirmedBy: "admin-1", confirmedAt: NOW });
    expect(() =>
      rejectPaymentState(confirmado, { rejectedBy: "admin-1", rejectedAt: NOW, reason: "Porque sí" }),
    ).toThrow(/no se puede rechazar desde ahí/);
  });
});

describe("reversePaymentState", () => {
  it("CONFIRMED -> REVERSED conservando la historia de la confirmación", () => {
    const confirmado = confirmPaymentState(pago(), { confirmedBy: "admin-1", confirmedAt: NOW });
    const resultado = reversePaymentState(confirmado, {
      reversedBy: "admin-2",
      reversedAt: NOW,
      reason: "Transferencia devuelta por el banco",
    });
    expect(resultado.status).toBe(PaymentStatus.REVERSED);
    expect(resultado.confirmedBy).toBe("admin-1");
    expect(resultado.confirmedAt).toBe(NOW);
    expect(resultado.reason).toBe("Transferencia devuelta por el banco");
    expect("reversedBy" in resultado).toBe(false);
  });

  it("no se reversa un pago sin confirmar", () => {
    expect(() =>
      reversePaymentState(pago(), { reversedBy: "admin-2", reversedAt: NOW, reason: "Por qué no" }),
    ).toThrow(/no se puede reversar/);
    const rechazado = rejectPaymentState(pago(), {
      rejectedBy: "admin-1",
      rejectedAt: NOW,
      reason: "No existe",
    });
    expect(() =>
      reversePaymentState(rechazado, { reversedBy: "admin-2", reversedAt: NOW, reason: "No" }),
    ).toThrow(PaymentError);
  });
});

describe("assertInstallmentLockedByPayment", () => {
  it("la cuota debe esperar exactamente este pago", () => {
    expect(() => assertInstallmentLockedByPayment(CUOTA_PENDIENTE, pago())).not.toThrow();
  });

  it("409 si el candado es de otro pago y 404 si es de otro préstamo", () => {
    try {
      assertInstallmentLockedByPayment(
        { ...CUOTA_PENDIENTE, pendingPaymentId: "PAY-2026-0009" },
        pago(),
      );
      expect.unreachable("debería lanzar");
    } catch (error) {
      expect((error as PaymentError).statusCode).toBe(409);
    }
    try {
      assertInstallmentLockedByPayment({ ...CUOTA_PENDIENTE, loanId: "loan-2" }, pago());
      expect.unreachable("debería lanzar");
    } catch (error) {
      expect((error as PaymentError).statusCode).toBe(404);
    }
  });
});

describe("effectConfirmInstallment", () => {
  it("saldas la cuota: PAID, paidPesos = total y suelta el candado", () => {
    const transicion = effectConfirmInstallment(CUOTA_PENDIENTE, pago(), NOW);
    expect(transicion.set).toEqual({
      paidPesos: 13_414,
      status: InstallmentStatus.PAID,
      paidAt: NOW,
      paymentId: "PAY-2026-0001",
    });
    expect(transicion.unset).toContain("pendingPaymentId");
  });

  it("rechaza si el saldo cambió desde que se registró el pago", () => {
    expect(() =>
      effectConfirmInstallment({ ...CUOTA_PENDIENTE, paidPesos: 2_500 }, pago(), NOW),
    ).toThrow(/saldo de la cuota cambió/);
  });

  it("no confirma encima de una cuota ya pagada", () => {
    expect(() =>
      effectConfirmInstallment({ ...CUOTA_PENDIENTE, status: InstallmentStatus.PAID }, pago(), NOW),
    ).toThrow(/ya está pagada/);
  });
});

describe("effectRejectInstallment", () => {
  it("solo suelta el candado: nada de montos ni estados", () => {
    expect(effectRejectInstallment()).toEqual({ set: {}, unset: ["pendingPaymentId"] });
  });
});

describe("effectReverseInstallment", () => {
  const PAGADA = {
    loanId: "loan-1",
    status: InstallmentStatus.PAID,
    paidPesos: 13_414,
    paymentId: "PAY-2026-0001",
  };

  it("devuelve la cuota a PENDING y quita paymentId/paidAt", () => {
    const transicion = effectReverseInstallment(PAGADA, pago());
    expect(transicion.set).toEqual({ paidPesos: 0, status: InstallmentStatus.PENDING });
    expect(transicion.unset.sort()).toEqual(["paidAt", "paymentId"]);
  });

  it("exige que la cuota siga pagada por este pago", () => {
    expect(() => effectReverseInstallment({ ...PAGADA, paymentId: "PAY-2026-0009" }, pago())).toThrow(
      /ya no está pagada por el pago/,
    );
    expect(() =>
      effectReverseInstallment({ ...PAGADA, status: InstallmentStatus.PENDING }, pago()),
    ).toThrow(PaymentError);
  });

  it("no reversa un pago mayor a lo pagado en la cuota (corrupción)", () => {
    expect(() => effectReverseInstallment({ ...PAGADA, paidPesos: 4_000 }, pago())).toThrow(
      /excede lo pagado/,
    );
  });

  it("con devoluciones parciales queda saldo pendiente en PENDING", () => {
    const transicion = effectReverseInstallment({ ...PAGADA, paidPesos: 15_000 }, pago({ amountPesos: 4_000 }));
    expect(transicion.set).toEqual({ paidPesos: 11_000, status: InstallmentStatus.PENDING });
  });
});
