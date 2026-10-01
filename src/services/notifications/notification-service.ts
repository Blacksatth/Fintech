import { type Firestore } from "firebase-admin/firestore";
import {
  buildNotificationDoc,
  notificationDocId,
  NotificationChannel,
  type NotificationType,
} from "@/server/notification-doc";
import { stripUndefined } from "@/server/doc";

/**
 * `NotificationService` (PROJECT_SPEC §16), la parte que F11 necesita.
 *
 * El MVP entrega **in-app**: escribir el doc en `notifications` ES la entrega (la bandeja del
 * cliente es una lectura de esa colección, en F15-1). `LogNotificationProvider` deja rastro en el
 * log del servidor, que es lo que §16 llama proveedor de log en dev. Email/WhatsApp/SMS son
 * proveedores futuros: no hay SMTP ni credenciales (decisión D6) y no se inventa ninguna
 * integración.
 *
 * **Sin spam por construcción**: el doc ID es determinista (`userId + tipo + entidad que provoca el
 * aviso`), así que avisar dos veces de lo mismo reescribe el mismo doc en vez de llenar la bandeja
 * de copias. La comprobación previa es una optimización, no la garantía: dos recálculos en
 * paralelo escriben contenido idéntico, que es inocuo.
 *
 * Los proveedores son **fábricas** y no constantes: cada uno recibe su `Firestore`. Un singleton con
 * la db "inyectada" compartiría estado entre peticiones concurrentes del mismo proceso.
 */

export interface NotificationDeps {
  db: Firestore;
}

export interface NotificationMessage {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Entidad que provoca el aviso (p. ej. `${loanId}_${installmentNumber}`). */
  refKey: string;
  payload?: Record<string, unknown>;
}

export interface NotificationResult {
  id: string;
  /** `false` si el aviso ya existía: reavisar no crea un segundo aviso. */
  created: boolean;
  /** Proveedores que se intentaron, en orden. */
  providers: string[];
}

export interface NotificationProvider {
  readonly name: string;
  /**
   * `true` si este proveedor guardó el aviso como nuevo. `false` si ya estaba (in-app) o si solo
   * deja rastro (log): un proveedor que no almacena nunca puede afirmar que creó nada.
   */
  deliver(message: NotificationMessage, now: Date): Promise<boolean>;
}

/** Bandeja in-app: el estado `SENT` con `sentAt` es lo que permite ordenar la bandeja sin cron. */
export function createInAppProvider(deps: NotificationDeps): NotificationProvider {
  return {
    name: "in-app",
    async deliver(message, now) {
      const doc = buildNotificationDoc(
        {
          userId: message.userId,
          type: message.type,
          channel: NotificationChannel.IN_APP,
          title: message.title,
          body: message.body,
          payload: { refKey: message.refKey, ...(message.payload ?? {}) },
        },
        now,
      );
      const id = notificationDocId(doc.userId, doc.type, message.refKey);
      const ref = deps.db.collection("notifications").doc(id);
      const snap = await ref.get();
      if (snap.exists) {
        return false;
      }
      await ref.set(stripUndefined(doc));
      return true;
    },
  };
}

/** Rastro en el log del servidor. No almacena, así que nunca reporta que creó el aviso. */
export const logNotificationProvider: NotificationProvider = {
  name: "log",
  async deliver(message) {
    console.info(
      `[notify] ${message.type} -> ${message.userId} (${message.refKey}): ${message.title}`,
    );
    return false;
  },
};

export function defaultProviders(deps: NotificationDeps): NotificationProvider[] {
  return [createInAppProvider(deps), logNotificationProvider];
}

/** Entrega un aviso por los proveedores indicados y dice si quedó uno nuevo. */
export async function notifyUser(
  deps: NotificationDeps,
  message: NotificationMessage,
  now: Date,
  providers: readonly NotificationProvider[] = defaultProviders(deps),
): Promise<NotificationResult> {
  const id = notificationDocId(message.userId, message.type, message.refKey);
  const attempted: string[] = [];
  let created = false;
  for (const provider of providers) {
    attempted.push(provider.name);
    if (await provider.deliver(message, now)) {
      created = true;
      break;
    }
  }
  return { id, created, providers: attempted };
}
