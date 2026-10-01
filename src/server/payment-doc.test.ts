import { describe, expect, it } from "vitest";
import {
  buildPaymentChannelDoc,
  buildPaymentDoc,
  buildPaymentEventDoc,
  paymentChannelDocSchema,
  paymentEventDocId,
  paymentDocSchema,
  paymentEventDocSchema,
  PaymentChannelType,
  Currency,
  PaymentStatus,
  ActorType,
} from "./payment-doc";

const NOW = new Date("2026-09-25T12:00:00.000Z");

const paymentInput = {
  paymentNumber: "PAY-2026-0001",
  userId: "uid-1",
  loanId: "loan-1",
  installmentId: "loan-1_2",
  amountPesos: 25_000,
  currency: Currency.COP,
  channel: PaymentChannelType.NEQUI,
  idempotencyKey: "key-1",
};

describe("payment-doc", () => {
  describe("paymentChannelDocSchema", () => {
    it("crea un canal válido", () => {
      const doc = buildPaymentChannelDoc(
        {
          name: "Nequi",
          type: PaymentChannelType.NEQUI,
          instructionsText: "Envía el valor exacto de la cuota al número indicado.",
          meta: { nequiNumber: "300 000 0000" },
        },
        NOW,
      );

      expect(doc.name).toBe("Nequi");
      expect(doc.type).toBe(PaymentChannelType.NEQUI);
      expect(doc.meta).toEqual({ nequiNumber: "300 000 0000" });
      expect(doc.isActive).toBe(true);
      expect(doc.createdAt).toBe(NOW);
      expect(doc.updatedAt).toBe(NOW);
    });

    it("meta es obligatorio como objeto (spec: meta sin '?'): vacío por defecto, nunca undefined", () => {
      const doc = buildPaymentChannelDoc(
        {
          name: "Código QR",
          type: PaymentChannelType.QR,
          instructionsText: "Escanea el QR estático que muestra la aplicación.",
        },
        NOW,
      );

      expect(doc.meta).toEqual({});
    });

    it("rechaza un tipo de canal fuera del enum del MVP", () => {
      expect(() =>
        buildPaymentChannelDoc(
          {
            name: "Wompi",
            type: "WOMPI" as PaymentChannelType,
            instructionsText: "Pago con tarjeta mediante un proveedor inventado.",
          },
          NOW,
        ),
      ).toThrow();
    });

    it("rechaza instrucciones demasiado cortas para que sirvan al cliente", () => {
      expect(() =>
        buildPaymentChannelDoc(
          { name: "Nequi", type: PaymentChannelType.NEQUI, instructionsText: "Nequi" },
          NOW,
        ),
      ).toThrow();
    });

    it("rechaza campos extra (strict): los datos de la cuenta van en meta, no sueltos", () => {
      const base = buildPaymentChannelDoc(
        {
          name: "Bre-B (ventanilla)",
          type: PaymentChannelType.BREB,
          instructionsText: "Paga en ventanilla Bre-B con la cláusula indicada.",
        },
        NOW,
      );

      expect(() => paymentChannelDocSchema.parse({ ...base, accountNumber: "000-000000" })).toThrow();
      expect(Object.keys(base).sort()).toEqual(
        ["createdAt", "instructionsText", "isActive", "meta", "name", "type", "updatedAt"].sort(),
      );
    });
  });

  describe("buildPaymentDoc", () => {
    it("un pago nace PENDING aunque el input no diga nada de estado", () => {
      const doc = buildPaymentDoc(paymentInput, NOW);

      expect(doc.status).toBe(PaymentStatus.PENDING);
      expect(doc.amountPesos).toBe(25_000);
      expect(doc.currency).toBe(Currency.COP);
      expect(doc.channel).toBe(PaymentChannelType.NEQUI);
      expect(doc.createdAt).toBe(NOW);
      expect(doc.updatedAt).toBe(NOW);
    });

    it("no guarda campos undefined (Firestore los rechaza)", () => {
      const doc = buildPaymentDoc(paymentInput, NOW);

      expect(doc.reference).toBeUndefined();
      expect(doc.receiptUrl).toBeUndefined();
      expect("reference" in doc).toBe(true);
    });

    it("rechaza un installmentId de otro préstamo", () => {
      expect(() =>
        buildPaymentDoc({ ...paymentInput, installmentId: "loan-OTRO_2" }, NOW),
      ).toThrow(/no pertenece al préstamo/);
    });

    it("rechaza un installmentId sin el sufijo numérico", () => {
      expect(() => buildPaymentDoc({ ...paymentInput, installmentId: "loan-1_" }, NOW)).toThrow();
      expect(() => buildPaymentDoc({ ...paymentInput, installmentId: "loan-1_abc" }, NOW)).toThrow();
    });

    it("rechaza montos que no son enteros seguros", () => {
      expect(() => buildPaymentDoc({ ...paymentInput, amountPesos: 25_000.5 }, NOW)).toThrow();
      expect(() => buildPaymentDoc({ ...paymentInput, amountPesos: 0 }, NOW)).toThrow();
      expect(() => buildPaymentDoc({ ...paymentInput, amountPesos: -1 }, NOW)).toThrow();
    });

    it("rechaza un pago sin idempotencyKey", () => {
      expect(() => buildPaymentDoc({ ...paymentInput, idempotencyKey: "" }, NOW)).toThrow();
    });

    it("no permite un CONFIRMED sin cuándo se confirmó", () => {
      const doc = buildPaymentDoc(paymentInput, NOW);

      expect(() =>
        paymentDocSchema.parse({ ...doc, status: PaymentStatus.CONFIRMED, confirmedBy: "admin-1" }),
      ).toThrow(/confirmedBy sin confirmedAt/);
    });

    it("no permite un REJECTED sin cuándo se rechazó", () => {
      const doc = buildPaymentDoc(paymentInput, NOW);

      expect(() =>
        paymentDocSchema.parse({ ...doc, status: PaymentStatus.REJECTED, rejectedBy: "admin-1" }),
      ).toThrow(/rejectedBy sin rejectedAt/);
    });

    it("acepta un REJECTED con motivo, actor y fecha", () => {
      const doc = buildPaymentDoc(paymentInput, NOW);
      const parsed = paymentDocSchema.parse({
        ...doc,
        status: PaymentStatus.REJECTED,
        rejectedBy: "admin-1",
        rejectedAt: NOW,
        reason: "La referencia no aparece en el extracto",
      });

      expect(parsed.status).toBe(PaymentStatus.REJECTED);
      expect(parsed.reason).toBeTruthy();
    });

    it("rechaza estados fuera de la máquina (PENDING/CONFIRMED/REJECTED/REVERSED)", () => {
      const doc = buildPaymentDoc(paymentInput, NOW);

      expect(() => paymentDocSchema.parse({ ...doc, status: "PAID" })).toThrow();
    });
  });

  describe("paymentEventDocId", () => {
    it("es determinista y ordena el historial sin query", () => {
      expect(paymentEventDocId("pay-1", 1)).toBe("pay-1_1");
      expect(paymentEventDocId("pay-1", 2)).toBe("pay-1_2");
      expect(paymentEventDocId("pay-1", 1)).toBe(paymentEventDocId("pay-1", 1));
    });

    it("rechaza secuencias que no son enteros >= 1", () => {
      expect(() => paymentEventDocId("pay-1", 0)).toThrow();
      expect(() => paymentEventDocId("pay-1", 1.5)).toThrow();
    });
  });

  describe("buildPaymentEventDoc", () => {
    it("registra la transición con actor y metadata", () => {
      const doc = buildPaymentEventDoc(
        {
          paymentId: "pay-1",
          fromStatus: PaymentStatus.PENDING,
          toStatus: PaymentStatus.CONFIRMED,
          actorType: ActorType.ADMIN,
          actorId: "admin-1",
          metadata: { installmentId: "loan-1_1", amountPesos: 25_000 },
        },
        NOW,
      );

      expect(doc.fromStatus).toBe(PaymentStatus.PENDING);
      expect(doc.toStatus).toBe(PaymentStatus.CONFIRMED);
      expect(doc.actorType).toBe(ActorType.ADMIN);
      expect(doc.actorId).toBe("admin-1");
      expect(doc.metadata).toEqual({ installmentId: "loan-1_1", amountPesos: 25_000 });
      expect(doc.createdAt).toBe(NOW);
    });

    it("metadata es obligatorio como objeto: vacío por defecto", () => {
      const doc = buildPaymentEventDoc(
        {
          paymentId: "pay-1",
          fromStatus: PaymentStatus.PENDING,
          toStatus: PaymentStatus.PENDING,
          actorType: ActorType.SYSTEM,
        },
        NOW,
      );

      expect(doc.metadata).toEqual({});
    });

    it("rechaza un actorId vacío y estados desconocidos", () => {
      expect(() =>
        buildPaymentEventDoc(
          {
            paymentId: "pay-1",
            fromStatus: PaymentStatus.PENDING,
            toStatus: PaymentStatus.CONFIRMED,
            actorType: ActorType.ADMIN,
            actorId: "  ",
          },
          NOW,
        ),
      ).toThrow();
      expect(() =>
        paymentEventDocSchema.parse({
          paymentId: "pay-1",
          fromStatus: PaymentStatus.PENDING,
          toStatus: "SETTLED",
          actorType: ActorType.ADMIN,
          metadata: {},
          createdAt: NOW,
        }),
      ).toThrow();
    });
  });
});
