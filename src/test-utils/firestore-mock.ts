import { FieldValue, type Firestore } from "firebase-admin/firestore";

export type MockDoc = Record<string, unknown>;

type WhereOp = "==" | ">" | ">=" | "<" | "<=";

interface WhereFilter {
  field: string;
  op: WhereOp;
  value: unknown;
}

interface OrderSpec {
  field: string;
  direction: "asc" | "desc";
}

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

function matches(doc: MockDoc, filter: WhereFilter): boolean {
  const actual = doc[filter.field];
  switch (filter.op) {
    case "==":
      return actual === filter.value;
    case ">":
      return compare(actual, filter.value) > 0;
    case ">=":
      return compare(actual, filter.value) >= 0;
    case "<":
      return compare(actual, filter.value) < 0;
    case "<=":
      return compare(actual, filter.value) <= 0;
  }
}

function snapshot(id: string, data: MockDoc | undefined) {
  return {
    id,
    exists: data !== undefined,
    data: () => data,
  };
}

/** Los `FieldValue.delete()` de la sesión de pago **borran** el campo, como en Firestore real. */
function isDeleteSentinel(value: unknown): boolean {
  return value instanceof FieldValue || (typeof value === "object" && value !== null && "_method" in value);
}

function applyUpdate(current: MockDoc | undefined, patch: MockDoc): MockDoc {
  const next: MockDoc = { ...(current ?? {}), ...patch };
  for (const key of Object.keys(patch)) {
    if (isDeleteSentinel(patch[key])) delete next[key];
  }
  return next;
}

export class InMemoryFirestore {
  private readonly collections = new Map<string, Map<string, MockDoc>>();
  private autoIdCounter = 0;
  /**
   * Consultas ejecutadas, en orden. Permite afirmar sobre la **forma** de la query (por ejemplo,
   * que nunca se combine `where` con `orderBy`, que en Firestore real exige un índice compuesto).
   */
  readonly queries: Array<{ collection: string; filters: WhereFilter[]; order: OrderSpec | null }> =
    [];

  seed(collection: string, id: string, doc: MockDoc): this {
    this.mapFor(collection).set(id, { ...doc });
    return this;
  }

  read(collection: string, id: string): MockDoc | undefined {
    return this.mapFor(collection).get(id);
  }

  list(collection: string): MockDoc[] {
    return [...this.mapFor(collection).values()];
  }

  ids(collection: string): string[] {
    return [...this.mapFor(collection).keys()];
  }

  remove(collection: string, id: string): void {
    this.mapFor(collection).delete(id);
  }

  clear(): void {
    this.collections.clear();
  }

  private mapFor(collection: string): Map<string, MockDoc> {
    let map = this.collections.get(collection);
    if (!map) {
      map = new Map();
      this.collections.set(collection, map);
    }
    return map;
  }

  private query(collection: string, filters: WhereFilter[], order: OrderSpec | null, limit: number | null) {
    this.queries.push({ collection, filters: [...filters], order });
    let rows = [...this.mapFor(collection).entries()].map(([id, doc]) => ({ id, doc }));

    for (const filter of filters) {
      rows = rows.filter((row) => matches(row.doc, filter));
    }

    if (order) {
      const direction = order.direction === "desc" ? -1 : 1;
      rows.sort((a, b) => compare(a.doc[order.field], b.doc[order.field]) * direction);
    }

    if (limit !== null) {
      rows = rows.slice(0, limit);
    }

    return {
      docs: rows.map((row) => snapshot(row.id, row.doc)),
      empty: rows.length === 0,
      size: rows.length,
    };
  }

  private makeRef(collection: string, id: string) {
    const [name, docId] = [collection, id];
    return {
      id: docId,
      path: `${name}/${docId}`,
      get: async () => snapshot(docId, this.mapFor(name).get(docId)),
      set: async (data: MockDoc) => {
        this.mapFor(name).set(docId, { ...data });
      },
      update: async (data: MockDoc) => {
        this.mapFor(name).set(docId, applyUpdate(this.mapFor(name).get(docId), data));
      },
    };
  }

  /**
   * Cadena de query encadenable. Comparte un único objeto entre `where`/`orderBy`/`limit` para
   * que las llamadas se acumulen, como en el SDK real.
   */
  private chain(name: string, filters: WhereFilter[], order: OrderSpec | null, limit: number | null) {
    const chain = {
      /** Permite que la transacción ejecute la query (`tx.get(query)`). */
      runQuery: () => this.query(name, filters, order, limit),
      where: (field: string, op: WhereOp, value: unknown) => {
        filters.push({ field, op, value });
        return chain;
      },
      orderBy: (field: string, direction: "asc" | "desc" = "asc") => {
        order = { field, direction };
        return chain;
      },
      limit: (n: number) => {
        limit = n;
        return chain;
      },
      get: () => this.query(name, filters, order, limit),
    };
    return chain;
  }

  collection(name: string) {
    return {
      doc: (id?: string) => {
        if (id === undefined) {
          this.autoIdCounter += 1;
          return this.makeRef(name, `auto-${this.autoIdCounter}`);
        }
        return this.makeRef(name, id);
      },
      /** Alta con id automático (como `collection.add()` en el SDK real). */
      add: async (data: MockDoc) => {
        this.autoIdCounter += 1;
        const autoId = `auto-${this.autoIdCounter}`;
        this.mapFor(name).set(autoId, { ...data });
        return { id: autoId, path: `${name}/${autoId}` };
      },
      get: async () => this.query(name, [], null, null),
      where: (field: string, op: WhereOp, value: unknown) =>
        this.chain(name, [{ field, op, value }], null, null),
      orderBy: (field: string, direction: "asc" | "desc" = "asc") =>
        this.chain(name, [], { field, direction }, null),
      limit: (n: number) => this.chain(name, [], null, n),
    };
  }

  /** Lectura múltiple por id (variádica, igual que el SDK): un solo round trip. */
  async getAll(...refs: Array<{ path: string }>) {
    return refs.map((ref) => {
      const [name, id] = ref.path.split("/");
      return snapshot(id, this.mapFor(name).get(id));
    });
  }

  runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const pending: Array<() => void> = [];

    const tx = {
      get: async (target: { path: string } | { runQuery: () => unknown }) => {
        if ("runQuery" in target) {
          return target.runQuery();
        }
        const { path } = target as { path: string };
        const [name, id] = path.split("/");
        return snapshot(id, this.mapFor(name).get(id));
      },
      /** Lectura por id determinista: un solo `getAll` (variádico) en vez de un query con indice. */
      getAll: async (...targets: Array<{ path: string }>) =>
        targets.map((target) => {
          const [name, id] = target.path.split("/");
          return snapshot(id, this.mapFor(name).get(id));
        }),
      set: (ref: { path: string }, data: MockDoc, options?: { merge?: boolean }) => {
        const [name, id] = ref.path.split("/");
        pending.push(() => {
          const current = this.mapFor(name).get(id);
          this.mapFor(name).set(id, options?.merge ? { ...current, ...data } : { ...data });
        });
      },
      update: (ref: { path: string }, data: MockDoc) => {
        const [name, id] = ref.path.split("/");
        pending.push(() =>
          this.mapFor(name).set(id, applyUpdate(this.mapFor(name).get(id), data)),
        );
      },
      delete: (ref: { path: string }) => {
        const [name, id] = ref.path.split("/");
        pending.push(() => this.mapFor(name).delete(id));
      },
    };

    return fn(tx).then((result) => {
      for (const write of pending) write();
      return result;
    });
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}

export function createFirestoreMock(): { store: InMemoryFirestore; db: Firestore } {
  const store = new InMemoryFirestore();
  return { store, db: store.asFirestore() };
}
