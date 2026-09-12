/**
 * IndexedDB 封装：无后台，全部数据保存在离线电脑本地浏览器。
 * stores: organizations / items(主键 barcode) / boxes(主键 id) / logs(自增 id)
 */
const DB_NAME = 'charity-warehouse';
const DB_VERSION = 1;
export const STORES = ['organizations', 'items', 'boxes', 'logs'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('organizations')) {
        db.createObjectStore('organizations', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('items')) {
        db.createObjectStore('items', { keyPath: 'barcode' });
      }
      if (!db.objectStoreNames.contains('boxes')) {
        db.createObjectStore('boxes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('logs')) {
        const s = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        s.createIndex('byBarcode', 'barcode', { unique: false });
        s.createIndex('byBox', 'boxId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞'));
  });
  return dbPromise;
}

/** 测试或“清空演示数据”后重新打开时使用 */
export async function deleteDb(): Promise<void> {
  // 必须先关闭已有连接，否则删除会被 blocked 事件永久挂起
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

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function txStore<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest | Promise<IDBRequest>,
  extraStores: StoreName[] = []
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction([store, ...extraStores], mode);
    const s = tx.objectStore(store);
    Promise.resolve(fn(s))
      .then(async (req) => {
        const result = await wrap(req as IDBRequest);
        tx.oncomplete = () => resolve(result as T);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('事务中止'));
      })
      .catch((err) => {
        tx.abort();
        reject(err);
      });
  });
}

/**
 * 在一个事务内操作多个 store —— 移箱/交接必须同时更新来源箱、目标箱、物品与日志，
 * 任何一步失败整笔回滚，避免出现“物品丢了/两边都有”的中间态。
 */
export async function atomic(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (stores: Record<StoreName, IDBObjectStore>) => Promise<void> | void
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
  return txStore<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return txStore<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export async function put(store: StoreName, value: unknown, extraStores: StoreName[] = []): Promise<IDBValidKey> {
  return txStore<IDBValidKey>(store, 'readwrite', (s) => s.put(value), extraStores);
}

export async function putAll(store: StoreName, values: unknown[]): Promise<void> {
  await atomic([store], 'readwrite', (s) => {
    for (const v of values) s[store].put(v);
  });
}

export async function clearStore(store: StoreName): Promise<void> {
  await txStore(store, 'readwrite', (s) => s.clear());
}
