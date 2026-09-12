/**
 * IndexedDB 封装 v2（多工程合并）。
 * stores:
 *   meta(单例 key='meta')  ledger(单例 key='ledger')
 *   organizations(主键 全局id)  boxes(主键 全局id)
 *   items(主键 itemId；barcode 只是普通字段+索引)
 *   logs(主键 uid 稳定编号；索引 byItem/byProject)
 *
 * DB_VERSION=2：v1 老库（barcode 主键、自增日志）自动就地迁移为“本机工程”身份。
 */
import type { Box, Item, MergeLedger, OperationLog, Organization, Review } from './types';
import { refOf } from './types';

const DB_NAME = 'charity-warehouse';
const DB_VERSION = 2;
export const STORES = ['meta', 'ledger', 'organizations', 'boxes', 'items', 'logs'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

export function newUid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `uid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const tx = req.transaction!;
      migrate(tx, req.result, ev.oldVersion).catch((e) => {
        try {
          tx.abort();
        } catch {
          /* ignore */
        }
        reject(e);
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function migrate(tx: IDBTransaction, db: IDBDatabase, oldVersion: number): Promise<void> {
  const fromV1 = oldVersion === 1;
  const pid = 'local-migrated';

  // —— 先读出 v1 数据（旧 schema：items 主键 barcode、logs 主键自增 id）——
  let v1: {
    items?: Array<Item & Record<string, unknown>>;
    boxes?: Box[];
    orgs?: Organization[];
    logs?: Array<OperationLog & Record<string, unknown>>;
  } = {};
  if (fromV1) {
    if (db.objectStoreNames.contains('items')) v1.items = await reqP(tx.objectStore('items').getAll());
    if (db.objectStoreNames.contains('boxes')) v1.boxes = (await reqP(tx.objectStore('boxes').getAll())) as Box[];
    if (db.objectStoreNames.contains('organizations')) v1.orgs = (await reqP(tx.objectStore('organizations').getAll())) as Organization[];
    if (db.objectStoreNames.contains('logs')) v1.logs = (await reqP(tx.objectStore('logs').getAll())) as Array<OperationLog & Record<string, unknown>>;
  }

  // —— 统一建立 v2 schema ——
  if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
  if (!db.objectStoreNames.contains('ledger')) db.createObjectStore('ledger', { keyPath: 'key' });
  if (db.objectStoreNames.contains('organizations')) db.deleteObjectStore('organizations');
  db.createObjectStore('organizations', { keyPath: 'id' });
  if (db.objectStoreNames.contains('boxes')) db.deleteObjectStore('boxes');
  db.createObjectStore('boxes', { keyPath: 'id' });
  if (db.objectStoreNames.contains('items')) db.deleteObjectStore('items');
  const itemsStore = db.createObjectStore('items', { keyPath: 'itemId' });
  itemsStore.createIndex('byBarcode', 'barcode', { unique: false });
  if (db.objectStoreNames.contains('logs')) db.deleteObjectStore('logs');
  const logsStore = db.createObjectStore('logs', { keyPath: 'uid' });
  logsStore.createIndex('byItem', 'itemId', { unique: false });
  logsStore.createIndex('byProject', 'projectId', { unique: false });

  if (!fromV1) return;

  // —— 回填 v1 -> v2 ——
  const orgMap = new Map<string, string>();
  for (const o of v1.orgs ?? []) {
    const gid = refOf(pid, (o as unknown as { id: string }).id);
    orgMap.set((o as unknown as { id: string }).id, gid);
    tx.objectStore('organizations').put({ ...o, id: gid, originProjectId: pid } satisfies Organization);
  }

  const boxMap = new Map<string, string>();
  for (const b of v1.boxes ?? []) {
    const local = (b as unknown as { id: string }).id;
    const gid = refOf(pid, local);
    boxMap.set(local, gid);
    tx.objectStore('boxes').put({
      ...b,
      id: gid,
      originProjectId: pid,
      orgId: orgMap.get(b.orgId) ?? refOf(pid, b.orgId),
      checks: Object.fromEntries(
        Object.entries(b.checks ?? {}).map(([barcode, v]) => [refOf(pid, barcode), v])
      )
    } satisfies Box);
  }

  for (const old of (v1.items ?? []) as unknown as Array<Item & { barcode: string; reviews: Review[] }>) {
    const itemId = refOf(pid, old.barcode);
    const oldLoc = old.location;
    const location: Item['location'] =
      oldLoc.kind === 'queue'
        ? { kind: 'queue' }
        : { ...oldLoc, boxId: boxMap.get(oldLoc.boxId) ?? refOf(pid, oldLoc.boxId) };
    tx.objectStore('items').put({
      itemId,
      originProjectId: pid,
      barcode: old.barcode,
      aliases: [],
      name: old.name,
      category: old.category,
      damage: old.damage,
      highValue: old.highValue,
      scannedAt: old.scannedAt,
      scanCount: old.scanCount ?? 1,
      reviews: (old.reviews ?? []).map((r, i) => ({
        uid: `mig-review-${old.barcode}-${i}`,
        projectId: pid,
        seq: i + 1,
        at: r.at,
        by: r.by,
        verdict: r.verdict,
        note: r.note
      })),
      location,
      createdAt: old.createdAt
    } satisfies Item);
  }

  const logs = [...(v1.logs ?? [])].sort(
    (a, b) => ((a as { id?: number }).id ?? 0) - ((b as { id?: number }).id ?? 0)
  );
  logs.forEach((l0, i) => {
    const old = l0 as unknown as OperationLog & { id: number; barcode?: string; boxId?: string; fromBoxId?: string; toBoxId?: string };
    tx.objectStore('logs').put({
      uid: `mig-${old.id}`,
      projectId: pid,
      seq: i + 1,
      at: old.at,
      type: old.type,
      operator: old.operator,
      itemId: old.barcode ? refOf(pid, old.barcode) : undefined,
      barcode: old.barcode,
      boxId: old.boxId ? boxMap.get(old.boxId) ?? refOf(pid, old.boxId) : undefined,
      fromBoxId: old.fromBoxId ? boxMap.get(old.fromBoxId) ?? refOf(pid, old.fromBoxId) : undefined,
      toBoxId: old.toBoxId ? boxMap.get(old.toBoxId) ?? refOf(pid, old.toBoxId) : undefined,
      detail: old.detail
    } satisfies OperationLog);
  });
}

export async function deleteDb(): Promise<void> {
  if (dbPromise) {
    try {
      (await dbPromise).close();
    } catch {
      /* ignore */
    }
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** 在一个事务内操作多个 store；移箱/交接/扫码必须与日志原子提交 */
export async function atomic(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (s: Record<StoreName, IDBObjectStore>) => Promise<void> | void
): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const handles = Object.fromEntries(
      STORES.filter((n) => stores.includes(n)).map((n) => [n, tx.objectStore(n)])
    ) as Record<StoreName, IDBObjectStore>;
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('事务中止'));
    Promise.resolve(fn(handles)).catch((err) => {
      try {
        tx.abort();
      } catch {
        /* ignore */
      }
      reject(err);
    });
  });
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll() as IDBRequest<T[]>;
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key) as IDBRequest<T | undefined>;
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function putAll(store: StoreName, values: unknown[]): Promise<void> {
  await atomic([store], 'readwrite', (s) => {
    for (const v of values) s[store].put(v);
  });
}

export async function clearStore(store: StoreName): Promise<void> {
  await atomic([store], 'readwrite', (s) => {
    s[store].clear();
  });
}

/** 默认空台账 */
export function emptyLedger(): MergeLedger {
  return { key: 'ledger', ingested: {}, adjudications: {}, packages: {} };
}
