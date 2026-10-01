/**
 * Firestore no acepta `undefined` como valor de campo. Los builders de
 * `credit-doc.ts` dejan los opcionales en `undefined` cuando no aplican, así que
 * todo doc que se escriba pasa por aquí.
 */
export function stripUndefined<T extends object>(doc: T): T {
  return Object.fromEntries(
    Object.entries(doc as Record<string, unknown>).filter(([, value]) => value !== undefined),
  ) as T;
}
