import { type Firestore } from "firebase-admin/firestore";
import {
  PAYMENT_CHANNEL_PUBLIC_META_KEYS,
  type PaymentChannelDoc,
  type PaymentChannelPublicMetaKey,
  type PaymentChannelType,
} from "@/server/payment-doc";

export interface PaymentChannelDeps {
  db: Firestore;
}

export interface PaymentChannelItem extends PaymentChannelDoc {
  id: string;
}

/**
 * Canales que el cliente puede usar para pagar.
 *
 * Sin `where(isActive) + orderBy(...)`: esa combinación exige un índice compuesto que no se puede
 * desplegar en este proyecto (trampa medida en F9-2: `FAILED_PRECONDITION: The query requires an
 * index`). La colección es de configuración —la escribe un admin y son un puñado de docs—, así que
 * se lee entera, se filtra y se ordena en memoria. El orden es estable por `name` con desempate
 * por `id`, igual que en `listApplicationsForAdmin`.
 */
export async function listActivePaymentChannels(
  deps: PaymentChannelDeps,
): Promise<PaymentChannelItem[]> {
  const snap = await deps.db.collection("payment_channels").get();
  return snap.docs
    .map((doc) => ({ ...(doc.data() as PaymentChannelDoc), id: doc.id }))
    .filter((channel) => channel.isActive === true)
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name, "es");
      return byName !== 0 ? byName : a.id.localeCompare(b.id);
    });
}

/**
 * Canal por id. Devuelve `null` si no existe **o** si está inactivo: un canal desactivado es
 * indistinguible de uno inexistente para quien paga, y así el cliente no ofrece un canal que el
 * admin ya cerró.
 */
export async function getActivePaymentChannel(
  deps: PaymentChannelDeps,
  channelId: string,
): Promise<PaymentChannelItem | null> {
  const snap = await deps.db.collection("payment_channels").doc(channelId).get();
  if (!snap.exists) return null;
  const channel = { ...(snap.data() as PaymentChannelDoc), id: snap.id };
  return channel.isActive === true ? channel : null;
}

/**
 * Proyecta un canal a lo que el cliente puede leer. Los valores no string se descartan.
 *
 * `meta` no es un blob decorativo: ahí están la cuenta a la que hay que transferir, el número
 * Nequi, la cláusula de Diálogo Activo y el QR. O sea, sin `meta` el cliente lee "transfiere a la
 * cuenta indicada" sin ninguna cuenta, que es el modo de fallo peor de todo el flujo. Por eso es
 * una **allowlist** (`PAYMENT_CHANNEL_PUBLIC_META_KEYS`, definida en el dominio porque la pantalla
 * de configuración también la necesita): `meta` es escritura de admin, y el día que alguien meta
 * ahí una nota interna o una credencial de un webhook, esta función sigue sin filtrarla.
 */
export interface PublicPaymentChannel {
  id: string;
  name: string;
  type: PaymentChannelType;
  instructionsText: string;
  /** Solo las claves públicas, y solo si el admin las rellenó. */
  meta: Partial<Record<PaymentChannelPublicMetaKey, string>>;
}

/** Proyecta un canal a lo que el cliente puede leer. Los valores no string se descartan. */
export function toPublicPaymentChannel(channel: PaymentChannelItem): PublicPaymentChannel {
  const meta: PublicPaymentChannel["meta"] = {};
  for (const key of PAYMENT_CHANNEL_PUBLIC_META_KEYS) {
    const value = channel.meta?.[key];
    if (typeof value === "string" && value.length > 0) {
      meta[key] = value;
    }
  }
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    instructionsText: channel.instructionsText,
    meta,
  };
}

/** Los canales activos, ya proyectados a la vista del cliente. */
export async function listPublicPaymentChannels(
  deps: PaymentChannelDeps,
): Promise<PublicPaymentChannel[]> {
  return (await listActivePaymentChannels(deps)).map(toPublicPaymentChannel);
}
