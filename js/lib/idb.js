const DB_NAME = "selector-compact3";
const STORES = ["tracks", "takes", "kv"];

let dbPromise = null;

function createMissing(db) {
  if (!db.objectStoreNames.contains("tracks")) {
    const s = db.createObjectStore("tracks", { keyPath: "id" });
    s.createIndex("addedAt", "addedAt");
  }
  if (!db.objectStoreNames.contains("takes")) {
    const s = db.createObjectStore("takes", { keyPath: "id" });
    s.createIndex("createdAt", "createdAt");
  }
  if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
}

function openVersion(requested) {
  return new Promise((resolve, reject) => {
    const rq = requested ? indexedDB.open(DB_NAME, requested) : indexedDB.open(DB_NAME);
    rq.onupgradeneeded = () => createMissing(rq.result);
    rq.onerror = () => reject(rq.error || new Error("IndexedDB open failed"));
    rq.onblocked = () => reject(new Error("IndexedDB is blocked by another tab — close other tabs of this app"));
    rq.onsuccess = () => resolve(rq.result);
  });
}

// Never pin a version number: an existing database is opened as-is, so a build
// that already had to upgrade cannot fail with VersionError on a later load.
async function openHealthy() {
  const db = await openVersion(0);
  const missing = STORES.filter((s) => !db.objectStoreNames.contains(s));
  if (!missing.length) return db;
  // A database can exist without our stores (a stray open, or an older partial
  // build). Force one real upgrade instead of failing every later transaction.
  const version = db.version;
  db.close();
  const upgraded = await openVersion(version + 1);
  const stillMissing = STORES.filter((s) => !upgraded.objectStoreNames.contains(s));
  if (stillMissing.length) {
    upgraded.close();
    throw new Error(`IndexedDB upgrade left stores missing: ${stillMissing.join(", ")}`);
  }
  return upgraded;
}

function open() {
  if (!dbPromise) dbPromise = openHealthy().catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

/**
 * Transaction wrapper.
 *
 * The completion handlers must be attached synchronously when the transaction is
 * created: a transaction auto-closes once its last request succeeds, so awaiting
 * the request first and only then setting oncomplete means the event already fired
 * and the returned promise never settles.
 */
function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(store, mode);
    } catch (e) {
      reject(e);
      return;
    }
    let result;
    let settled = false;
    t.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
    t.onerror = () => { if (!settled) { settled = true; reject(t.error || new Error("transaction error")); } };
    t.onabort = () => { if (!settled) { settled = true; reject(t.error || new Error("transaction aborted")); } };
    Promise.resolve(fn(t.objectStore(store)))
      .then((r) => { result = r; })
      .catch((e) => {
        if (!settled) { settled = true; reject(e); }
        try { t.abort(); } catch { /* already finished */ }
      });
  }));
}

const req = (p) => new Promise((res, rej) => {
  p.onsuccess = () => res(p.result);
  p.onerror = () => rej(p.error);
});

export const idb = {
  tracks: {
    all: () => tx("tracks", "readonly", (s) => req(s.getAll())),
    put: (rec) => tx("tracks", "readwrite", (s) => req(s.put(rec))),
    del: (id) => tx("tracks", "readwrite", (s) => req(s.delete(id))),
  },
  takes: {
    all: () => tx("takes", "readonly", (s) => req(s.getAll())),
    put: (rec) => tx("takes", "readwrite", (s) => req(s.put(rec))),
    del: (id) => tx("takes", "readwrite", (s) => req(s.delete(id))),
  },
  kv: {
    get: (key) => tx("kv", "readonly", (s) => req(s.get(key))),
    set: (key, val) => tx("kv", "readwrite", (s) => req(s.put(val, key))),
    del: (key) => tx("kv", "readwrite", (s) => req(s.delete(key))),
  },
  estimate: async () => {
    if (!navigator.storage?.estimate) return {};
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted: !!(await navigator.storage.persisted?.()) };
  },
  requestPersist: async () => !!(await navigator.storage.persist?.()),
};
