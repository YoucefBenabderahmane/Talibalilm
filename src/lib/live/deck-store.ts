'use client';

/**
 * The files a teacher dropped into a class, kept on her own machine.
 *
 * The live deck opens files in the browser instead of uploading them, so a
 * reload would otherwise lose the deck mid-lesson and send her looking for the
 * file again. Each dropped file is kept in IndexedDB under the class it was
 * dropped into, with the pages she removed, and the room reopens them by itself.
 *
 * Best-effort throughout: storage that is full or blocked must never stop the
 * slides from being shown — the caller only loses the restore-after-reload.
 */

const DB_NAME = 'talibalim-live-decks';
const DB_VERSION = 1;
const STORE = 'sources';

export interface StoredSource {
  key: string;
  sessionId: string;
  sourceId: string;
  name: string;
  type: string;
  file: Blob;
  removed: number[];
  addedAt: number;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

let opening: Promise<IDBDatabase | null> | null = null;

function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

const keyOf = (sessionId: string, sourceId: string) => `${sessionId}:${sourceId}`;

/** Keep one dropped file for this class. False when storage refused it. */
export async function keepSource(
  sessionId: string,
  sourceId: string,
  file: File,
): Promise<boolean> {
  const db = await database();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      key: keyOf(sessionId, sourceId),
      sessionId,
      sourceId,
      name: file.name,
      type: file.type,
      file,
      removed: [],
      addedAt: Date.now(),
    } satisfies StoredSource);
    await done(tx);
    return true;
  } catch {
    return false;
  }
}

export async function setRemovedPages(
  sessionId: string,
  sourceId: string,
  removed: number[],
): Promise<void> {
  const db = await database();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const row = (await request(store.get(keyOf(sessionId, sourceId)))) as StoredSource | undefined;
    if (row) store.put({ ...row, removed });
    await done(tx);
  } catch {
    /* The deck still works; only the restore would show the page again. */
  }
}

export async function forgetSource(sessionId: string, sourceId: string): Promise<void> {
  const db = await database();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(keyOf(sessionId, sourceId));
    await done(tx);
  } catch {
    /* Cleared by the age purge. */
  }
}

/** This class's files, oldest first, so the deck comes back in the same order. */
export async function sourcesFor(sessionId: string): Promise<StoredSource[]> {
  const db = await database();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE, 'readonly');
    const rows = (await request(tx.objectStore(STORE).getAll())) as StoredSource[];
    return rows.filter((r) => r.sessionId === sessionId).sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    return [];
  }
}

/** Files dropped into classes more than `ms` ago are not kept forever. */
export async function purgeOlderThan(ms: number): Promise<void> {
  const db = await database();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const rows = (await request(store.getAll())) as StoredSource[];
    const cutoff = Date.now() - ms;
    for (const row of rows) if (row.addedAt < cutoff) store.delete(row.key);
    await done(tx);
  } catch {
    /* Housekeeping only. */
  }
}
