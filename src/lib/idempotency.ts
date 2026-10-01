import { createHash } from "node:crypto";
import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";

export function idempotencyKeyId(scope: string, key: string): string {
  return createHash("sha256").update(`${scope}|${key}`, "utf8").digest("hex");
}

export interface IdempotencyOutcome {
  /** `true` = la clave ya existía y `run` NO se ejecutó. */
  replayed: boolean;
  keyId: string;
  entityType: string;
  /**
   * ID con el que quedó la entidad. En un replay es el que guardó la **primera** ejecución,
   * no el que pasó el llamador: por eso el servicio nunca reconstruye la respuesta a partir
   * de este valor sino leyendo la entidad.
   *
   * `undefined` solo es posible con registros antiguos que nunca guardaron `entityId`.
   */
  entityId: string | undefined;
}

/**
 * Lo que devuelve `run` cuando **la entidad se crea dentro de la transacción** y su ID no se
 * conoce de antemano: el pago, cuyo `paymentNumber` es un consecutivo que se reserva leyendo
 * el mayor del año dentro de la misma transacción que lo escribe.
 */
export interface IdempotencyRunResult {
  entityId?: string;
}

export interface WithIdempotencyParams {
  scope: string;
  key: string;
  /**
   * Qué entidad muta esta operación. Es lo que permite **reconstruir la respuesta
   * leyendo la entidad** en vez de guardarla en el registro de idempotencia.
   */
  entityType: string;
  /**
   * ID de la entidad cuando se conoce **antes** de la transacción. Omitirlo cuando `run` crea la
   * entidad y devuelve su ID: el registro guarda el que devolvió `run`.
   */
  entityId?: string;
  ttlMs?: number;
  run: (t: Transaction) => Promise<IdempotencyRunResult | void>;
}

function isExpired(data: Record<string, unknown>, now: number): boolean {
  const expiresAt = data["expiresAt"];
  if (expiresAt === undefined) return false;
  const ms =
    typeof expiresAt === "object" && expiresAt !== null && "toMillis" in expiresAt
      ? ((expiresAt as { toMillis(): number }).toMillis())
      : (expiresAt as number);
  return ms <= now;
}

/**
 * Guarda de ejecución única. Doc `idempotency_keys/{sha256(scope|key)}` con la forma de
 * PROJECT_SPEC §8.1: `scope, key, entityType, entityId, createdAt, expiresAt`.
 *
 * El registro **no guarda el resultado**: un replay no ejecuta `run` y el llamador
 * reconstruye la respuesta leyendo la entidad (`entityType`/`entityId`). Así el registro
 * nunca duplica datos de negocio ni puede desincronizarse de ellos.
 *
 * El `set` es sin `merge` a propósito: garantiza que el doc tenga exactamente la forma del
 * spec. Los docs de la versión previa (con `result`) se ignoran en replay y el TTL los
 * retira solos en cuanto vencen.
 */
export async function withIdempotency(
  db: Firestore,
  params: WithIdempotencyParams,
): Promise<IdempotencyOutcome> {
  const keyId = idempotencyKeyId(params.scope, params.key);
  const ttlMs = params.ttlMs ?? 24 * 60 * 60 * 1000;
  const ref = db.collection("idempotency_keys").doc(keyId);

  const outcome = await db.runTransaction(async (t) => {
    const snapshot = await t.get(ref);
    if (snapshot.exists) {
      const data = snapshot.data() as Record<string, unknown>;
      if (!isExpired(data, Date.now())) {
        // Replay: el registro manda. Si el doc es de la versión previa y no trae `entityId`, se
        // usa el del llamador; si tampoco lo hay, el servicio lo descubre leyendo la entidad.
        const stored = data["entityId"];
        return { replayed: true as const, entityId: typeof stored === "string" ? stored : params.entityId };
      }
      t.delete(ref);
    }

    const result = await params.run(t);
    const entityId = result?.entityId ?? params.entityId;
    if (entityId === undefined) {
      // Omitir `entityId` sin devolverlo dejaría un registro sin poder reconstruir su entidad:
      // el replay devolvería un id desconocido en lugar de un fallo. Se aborta la transacción
      // (nada se escribe) y se falla en voz alta.
      throw new Error(
        `withIdempotency(${params.scope}): la operación no indicó el id de la entidad. ` +
          "Pasa `entityId` o devuelve `{ entityId }` desde `run`",
      );
    }
    t.set(ref, {
      scope: params.scope,
      key: params.key,
      entityType: params.entityType,
      entityId,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return { replayed: false as const, entityId };
  });

  return {
    replayed: outcome.replayed,
    keyId,
    entityType: params.entityType,
    entityId: outcome.entityId,
  };
}
