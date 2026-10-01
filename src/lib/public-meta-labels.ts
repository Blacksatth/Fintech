import type { PaymentChannelPublicMetaKey } from "@/server/payment-doc";

/**
 * Etiquetas en español de las claves públicas de `payment_channels.meta`.
 *
 * Viven aparte del componente y aparte del dominio a propósito. Las **claves** son contrato
 * (`payment-doc`, compartidas con el servicio de pagos); las **etiquetas** son de presentación y
 * cambian con el diseño, no con el negocio. Mezclarlas haría que cambiar un texto de la pantalla
 * tocara el módulo que valida los datos.
 */
export const PUBLIC_META_LABELS: Record<PaymentChannelPublicMetaKey, string> = {
  bankName: "Banco o entidad",
  accountType: "Tipo de cuenta",
  accountNumber: "Número de cuenta",
  accountHolder: "Titular de la cuenta",
  nequiNumber: "Número Nequi",
  clauseDialogoActivo: "Cláusula de diálogo activo",
  qrImageUrl: "URL de la imagen QR",
};

/**
 * Las claves que la pantalla ofrece, en el orden en que se leen.
 *
 * El `satisfies` con la lista del dominio es a propósito: si `payment-doc` agrega una clave pública
 * (por ejemplo un nuevo dato que el cliente debe ver), el typecheck falla aquí hasta que la pantalla
 * la ofrezca. Una clave editable que no aparece en ningún formulario es datos que el admin no puede
 * corregir, y eso se descubre tarde y por soporte.
 */
export const PUBLIC_META_KEYS = [
  "bankName",
  "accountType",
  "accountNumber",
  "accountHolder",
  "nequiNumber",
  "clauseDialogoActivo",
  "qrImageUrl",
] as const satisfies readonly PaymentChannelPublicMetaKey[];

export type PublicMetaKey = (typeof PUBLIC_META_KEYS)[number];