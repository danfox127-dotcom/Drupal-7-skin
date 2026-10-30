/**
 * A small key-value store that only the extension's own contexts can open.
 *
 * Why not chrome.storage.local: Chrome exposes it to content scripts by default, and its
 * setAccessLevel restricts the WHOLE area, which our content scripts need for their settings,
 * the pending notice and the menu cache. So a credential kept there is readable by anything
 * that takes over a Columbia admin tab's renderer (page JavaScript itself cannot reach it; the
 * content script runs in an isolated world).
 *
 * This is IndexedDB in the extension's own origin. A content script's `indexedDB` belongs to
 * the PAGE's origin, so it cannot open this database, and site isolation keeps the database
 * out of the page's renderer process. The service worker and the extension's own pages can.
 *
 * Writes resolve when their transaction COMMITS, not when the request succeeds: a service
 * worker can be stopped between the two, and a write that only looked done would be lost.
 */

export const TRUSTED_DB = 'd7studio-trusted';
export const TRUSTED_DB_VERSION = 1;
export const TRUSTED_STORE = 'kv';

export interface TrustedStore {
  /** The value under `key`, or undefined when there is none. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

let opening: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(TRUSTED_DB, TRUSTED_DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(TRUSTED_STORE)) {
          request.result.createObjectStore(TRUSTED_STORE);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Closed by the browser or asked to make way for a newer version: the next call reopens.
        const forget = () => { db.close(); opening = null; };
        db.onclose = forget;
        db.onversionchange = forget;
        resolve(db);
      };
      // No onblocked: a blocked open is not a failure. It completes once older connections
      // close, which onversionchange above makes them do.
      request.onerror = () => reject(request.error);
    });
    opening.catch(() => { opening = null; });
  }
  return opening;
}

async function transact<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(TRUSTED_STORE, mode);
    const request = work(tx.objectStore(TRUSTED_STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error ?? new Error('The trusted store transaction was aborted.'));
  });
}

export const trustedStore: TrustedStore = {
  get: key => transact('readonly', store => store.get(key)),
  set: async (key, value) => { await transact('readwrite', store => store.put(value, key)); },
  remove: async key => { await transact('readwrite', store => store.delete(key)); },
};
