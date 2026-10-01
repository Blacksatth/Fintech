import { describe, expect, it } from "vitest";
import { toPublicPaymentChannel, type PaymentChannelItem } from "./payment-channel-service";
import { PaymentChannelType } from "@/server/payment-doc";

/**
 * La proyección pública de canales (F10-4).
 *
 * Se prueba como función pura a propósito: lo que importa no es qué hay en Firestore sino qué
 * **sale** hacia el navegador cuando un admin guardó cualquier cosa en `meta`.
 */

function canal(meta: Record<string, unknown>): PaymentChannelItem {
  return {
    id: PaymentChannelType.BANK_TRANSFER,
    name: "Transferencia bancaria",
    type: PaymentChannelType.BANK_TRANSFER,
    instructionsText: "Transfiere a la cuenta indicada.",
    meta,
    isActive: true,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
  };
}

describe("toPublicPaymentChannel", () => {
  it("deja pasar los datos con los que el cliente paga", () => {
    const public0 = toPublicPaymentChannel(
      canal({
        bankName: "BANCO DEMO",
        accountType: "AHORRO",
        accountNumber: "000-000000",
        accountHolder: "MICROCREDITO DEMO S.A.S.",
      }),
    );

    expect(public0.meta).toEqual({
      bankName: "BANCO DEMO",
      accountType: "AHORRO",
      accountNumber: "000-000000",
      accountHolder: "MICROCREDITO DEMO S.A.S.",
    });
  });

  it("deja pasar el Nequi, la cláusula y el QR", () => {
    const public0 = toPublicPaymentChannel(
      canal({
        nequiNumber: "300 000 0000",
        clauseDialogoActivo: "CLÁUSULA",
        qrImageUrl: "https://res.cloudinary.com/demo/image/upload/qr.png",
      }),
    );

    expect(public0.meta).toEqual({
      nequiNumber: "300 000 0000",
      clauseDialogoActivo: "CLÁUSULA",
      qrImageUrl: "https://res.cloudinary.com/demo/image/upload/qr.png",
    });
  });

  it("descarta lo que no está en la allowlist aunque el admin lo haya escrito", () => {
    const public0 = toPublicPaymentChannel(
      canal({
        accountNumber: "000-000000",
        internalNote: "llamar al cliente antes de confirmar",
        webhookSecret: "whsec_123",
        adminEmail: "pagos@interno.example",
      }),
    );

    expect(public0.meta).toEqual({ accountNumber: "000-000000" });
    expect(public0.meta).not.toHaveProperty("webhookSecret");
    expect(public0.meta).not.toHaveProperty("internalNote");
  });

  it("descarta valores que no son texto: un número en meta no llega al cliente", () => {
    const public0 = toPublicPaymentChannel(canal({ accountNumber: 12345, nequiNumber: null }));

    expect(public0.meta).toEqual({});
  });

  it("no inventa claves: un canal sin meta sale con meta vacío, no con nulls", () => {
    const public0 = toPublicPaymentChannel(canal({}));

    expect(public0.meta).toEqual({});
  });

  it("aguanta un meta ausente en un documento viejo", () => {
    const sinMeta = { ...canal({}), meta: undefined } as unknown as PaymentChannelItem;

    expect(toPublicPaymentChannel(sinMeta).meta).toEqual({});
  });

  it("conserva nombre, tipo e instrucciones", () => {
    const public0 = toPublicPaymentChannel(canal({}));

    expect(public0.name).toBe("Transferencia bancaria");
    expect(public0.type).toBe(PaymentChannelType.BANK_TRANSFER);
    expect(public0.instructionsText).toBe("Transfiere a la cuenta indicada.");
  });
});
