// Minimal IndexedDB key/value store for the offline snapshot and the write queue.
let dbp = Promise.reject(new Error('idb not opened'));
dbp.catch(() => {});

export function openDb(name) {
  dbp = new Promise((resolve, reject) => {
    try {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    } catch (e) { reject(e); }
  });
  dbp.catch(() => {});
}

async function run(mode, fn) {
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
export const idbGet = (k) => run('readonly', (s) => s.get(k)).catch(() => undefined);
/** Rejects on QuotaExceededError; callers report it. */
export const idbSet = (k, v) => run('readwrite', (s) => s.put(v, k));
export const idbClear = () => run('readwrite', (s) => s.clear()).catch(() => {});
