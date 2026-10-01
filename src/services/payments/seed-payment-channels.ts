import { type Firestore } from "firebase-admin/firestore";
import { stripUndefined } from "@/server/doc";
import { buildPaymentChannelDoc, PaymentChannelType } from "@/server/payment-doc";

/**
 * Canales de pago de demostración (PROJECT_SPEC §11: transferencia / QR / Nequi / Bre-B como
 * **texto estático configurable**, sin ninguna API de pago).
 *
 * Los datos de las cuentas son **ficticios y visibles como tales**. Un número de cuenta
 * inventado en `meta` es el modo de fallo peligroso de esta tarea: alguien paga a un número que
 * parece real y el dinero se pierde. Por eso cada canal se sembrado lleva `legalReview:
 * PENDING_LEGAL_REVIEW` y `demo: true`, y las instrucciones dicen que son de demostración.
 */

export interface SeedPaymentChannelsResult {
  channelsCreated: number;
  /** Rutas `payment_channels/{id}` creadas (para log y para que el test de integración las limpie). */
  channels: string[];
}

/** Orden de presentación en la UI del cliente. */
const DISPLAY_ORDER = ["BANK_TRANSFER", "NEQUI", "QR", "BREB"] as const;

interface DemoChannel {
  type: PaymentChannelType;
  name: string;
  instructionsText: string;
  meta: Record<string, unknown>;
}

const DEMO_CHANNELS: readonly DemoChannel[] = [
  {
    type: PaymentChannelType.BANK_TRANSFER,
    name: "Transferencia bancaria",
    instructionsText:
      "DATOS DE DEMOSTRACIÓN — reemplazar antes de producción. Transfiere el valor exacto de la " +
      "cuota a la cuenta indicada, escribe la referencia de la transferencia y registra el pago. " +
      "Un admin confirma el pago revisando su banco: subir el comprobante no mueve ningún saldo.",
    meta: {
      bankName: "BANCO DEMO",
      accountType: "AHORRO",
      accountNumber: "000-000000",
      accountHolder: "MICROCREDITO DEMO S.A.S.",
      demo: true,
      legalReview: "PENDING_LEGAL_REVIEW",
    },
  },
  {
    type: PaymentChannelType.NEQUI,
    name: "Nequi",
    instructionsText:
      "DATOS DE DEMOSTRACIÓN — reemplazar antes de producción. Envía el valor exacto de la cuota " +
      "al número Nequi indicado y registra la referencia del movimiento. La confirmación la hace un " +
      "admin: el comprobante adjunto no confirma nada.",
    meta: {
      nequiNumber: "300 000 0000",
      accountHolder: "MICROCREDITO DEMO S.A.S.",
      demo: true,
      legalReview: "PENDING_LEGAL_REVIEW",
    },
  },
  {
    type: PaymentChannelType.QR,
    name: "Código QR",
    instructionsText:
      "DATOS DE DEMOSTRACIÓN — reemplazar antes de producción. Escanea el QR que aparece en " +
      "este canal o en la aplicación de pago, paga el valor exacto de la cuota y registra la " +
      "referencia. Sin API de pago: el QR es una imagen estática que el admin reemplaza.",
    meta: {
      // Sin `qrImageUrl`: una cadena vacía se renderizaría como un `img src=""` roto. La clave se
      // agrega cuando el admin suba su imagen real (F10-4).
      demo: true,
      legalReview: "PENDING_LEGAL_REVIEW",
    },
  },
  {
    type: PaymentChannelType.BREB,
    name: "Bre-B (ventanilla)",
    instructionsText:
      "DATOS DE DEMOSTRACIÓN — reemplazar antes de producción. Paga tu cuota en una ventanilla " +
      "Bre-B usando los datos de la cláusula Dialogo Activo indicados y registra el número del " +
      "comprobante. El admin confirma contra el extracto de la cuenta.",
    meta: {
      clauseDialogoActivo: "CLÁUSULA DE DEMOSTRACIÓN",
      demo: true,
      legalReview: "PENDING_LEGAL_REVIEW",
    },
  },
];

/** El doc ID es el tipo: un canal por tipo, y `payments.channel` lo referencia directamente. */
export function paymentChannelDocId(type: PaymentChannelType): string {
  return type;
}

/**
 * Idempotente y **no destructivo**: si el canal ya existe no se toca.
 *
 * Reejecutar el seed no puede sobrescribir unas instrucciones que un admin ya editó con sus datos
 * reales; `credit_products` y `risk_rules` se siembran igual (solo si faltan) por el mismo motivo.
 */
export async function seedPaymentChannels(db: Firestore): Promise<SeedPaymentChannelsResult> {
  const now = new Date();
  const channels: string[] = [];
  let channelsCreated = 0;

  const order = new Map(DISPLAY_ORDER.map((type, index) => [type, index]));
  const ordered = [...DEMO_CHANNELS].sort(
    (a, b) => (order.get(a.type) ?? 0) - (order.get(b.type) ?? 0),
  );

  for (const channel of ordered) {
    const id = paymentChannelDocId(channel.type);
    const ref = db.collection("payment_channels").doc(id);
    const snap = await ref.get();
    if (snap.exists) continue;

    const doc = buildPaymentChannelDoc(
      {
        name: channel.name,
        type: channel.type,
        instructionsText: channel.instructionsText,
        meta: { ...channel.meta, displayOrder: order.get(channel.type) ?? 0 },
        isActive: true,
      },
      now,
    );
    await ref.set(stripUndefined(doc));
    channelsCreated++;
    channels.push(`payment_channels/${id}`);
  }

  return { channelsCreated, channels };
}
