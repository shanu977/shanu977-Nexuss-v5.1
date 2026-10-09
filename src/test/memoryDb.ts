/**
 * In-memory stand-in for `@/lib/db/db` in component/service tests.
 *
 * The real Dexie database runs on fake-indexeddb, whose transaction handling
 * can wedge when a component's dangling async chain writes while the next
 * test's beforeEach clears tables — hanging otherwise-passing tests. Tests
 * here only assert store state, never persistence, so a synchronous
 * resolution-order stub is both faster and deterministic.
 */
export interface MemoryTable {
  add: (item: { id?: string } & Record<string, unknown>) => Promise<string>;
  bulkAdd: (items: Array<{ id?: string } & Record<string, unknown>>) => Promise<string[]>;
  update: (id: string, changes: Record<string, unknown>) => Promise<number>;
  get: (id: string) => Promise<Record<string, unknown> | undefined>;
  delete: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  toArray: () => Promise<Record<string, unknown>[]>;
  where: (index: string) => {
    equals: (value: unknown) => {
      toArray: () => Promise<Record<string, unknown>[]>;
      delete: () => Promise<void>;
    };
  };
}

function makeTable(): MemoryTable & { rows: Record<string, Record<string, unknown>> } {
  const rows: Record<string, Record<string, unknown>> = {};
  let seq = 0;
  const matches = (index: string, value: unknown) =>
    Object.values(rows).filter((r) => r[index] === value);
  return {
    rows,
    async add(item) {
      const id = item.id ?? `row-${++seq}`;
      rows[id] = { ...item, id };
      return id;
    },
    async bulkAdd(items) {
      const ids: string[] = [];
      for (const item of items) {
        const id = item.id ?? `row-${++seq}`;
        rows[id] = { ...item, id };
        ids.push(id);
      }
      return ids;
    },
    async update(id, changes) {
      if (!rows[id]) return 0;
      Object.assign(rows[id], changes);
      return 1;
    },
    async get(id) {
      return rows[id];
    },
    async delete(id) {
      delete rows[id];
    },
    async clear() {
      for (const key of Object.keys(rows)) delete rows[key];
    },
    async toArray() {
      return Object.values(rows);
    },
    where(index) {
      return {
        equals(value) {
          return {
            async toArray() {
              return matches(index, value);
            },
            async delete() {
              for (const row of matches(index, value)) delete rows[row.id as string];
            },
          };
        },
      };
    },
  };
}

export function createMemoryDb() {
  const tables = {
    chats: makeTable(),
    messages: makeTable(),
    usageRecords: makeTable(),
    localProviders: makeTable(),
    localModels: makeTable(),
  };
  const db = {
    ...tables,
    // Matches Dexie: transaction(mode, ...tables, callback)
    async transaction(_mode: string, ...args: unknown[]) {
      const cb = args[args.length - 1] as () => Promise<unknown>;
      return cb();
    },
  };
  return db;
}
