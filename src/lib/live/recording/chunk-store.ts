/**
 * The recording, written to the teacher's disk as it is made.
 *
 * It used to live only in the page's memory until « Arrêter ». A reload, a
 * crash, « Quitter » or the error screen's « Réessayer » threw the whole lesson
 * away, and an hour of class sat in RAM the whole time. Every five-second chunk
 * now also goes into IndexedDB, so a class that ends badly can be downloaded
 * the next time the room opens.
 *
 * Every call is best-effort and never throws: storage that is full, blocked
 * (private window) or missing must not stop the recording itself — the caller
 * keeps the chunks in memory as before and tells the teacher the safety net
 * is off.
 */

const DB_NAME = 'talibalim-recordings';
const DB_VERSION = 1;
const RECORDINGS = 'recordings';
const CHUNKS = 'chunks';

export interface StoredRecording {
  id: string;
  /** The download name without extension, e.g. "cours-2026-10-11-partie-2". */
  name: string;
  mimeType: string;
  startedAt: number;
  updatedAt: number;
  chunks: number;
  bytes: number;
  /** True once the file was handed to the downloader. */
  saved: boolean;
}

export interface ChunkStore {
  begin(recording: Omit<StoredRecording, 'chunks' | 'bytes' | 'saved' | 'updatedAt'>): Promise<boolean>;
  append(id: string, seq: number, blob: Blob): Promise<boolean>;
  markSaved(id: string): Promise<void>;
  /** Recordings that were never downloaded and hold at least one chunk. */
  pending(): Promise<StoredRecording[]>;
  assemble(id: string): Promise<Blob | null>;
  remove(id: string): Promise<void>;
  /** Drop recordings already downloaded, older than `ms`. Keeps the disk clean. */
  purgeSaved(olderThanMs: number): Promise<void>;
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDINGS)) db.createObjectStore(RECORDINGS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ['id', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  });
}

/** Null when this browser offers no usable IndexedDB; the caller keeps memory only. */
export async function openChunkStore(): Promise<ChunkStore | null> {
  if (typeof indexedDB === 'undefined') return null;
  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch {
    return null;
  }

  const chunkRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

  const store: ChunkStore = {
    async begin(recording) {
      try {
        const tx = db.transaction(RECORDINGS, 'readwrite');
        tx.objectStore(RECORDINGS).put({
          ...recording,
          updatedAt: Date.now(),
          chunks: 0,
          bytes: 0,
          saved: false,
        } satisfies StoredRecording);
        await done(tx);
        return true;
      } catch {
        return false;
      }
    },

    async append(id, seq, blob) {
      try {
        const tx = db.transaction([RECORDINGS, CHUNKS], 'readwrite');
        tx.objectStore(CHUNKS).put({ id, seq, blob });
        const recordings = tx.objectStore(RECORDINGS);
        const row = (await request(recordings.get(id))) as StoredRecording | undefined;
        if (row) {
          recordings.put({
            ...row,
            chunks: row.chunks + 1,
            bytes: row.bytes + blob.size,
            updatedAt: Date.now(),
          });
        }
        await done(tx);
        return true;
      } catch {
        return false;
      }
    },

    async markSaved(id) {
      try {
        const tx = db.transaction(RECORDINGS, 'readwrite');
        const store = tx.objectStore(RECORDINGS);
        const row = (await request(store.get(id))) as StoredRecording | undefined;
        if (row) store.put({ ...row, saved: true, updatedAt: Date.now() });
        await done(tx);
      } catch {
        /* Not fatal: the worst case is the file being offered again later. */
      }
    },

    async pending() {
      try {
        const tx = db.transaction(RECORDINGS, 'readonly');
        const rows = (await request(tx.objectStore(RECORDINGS).getAll())) as StoredRecording[];
        return rows
          .filter((row) => !row.saved && row.chunks > 0)
          .sort((a, b) => b.startedAt - a.startedAt);
      } catch {
        return [];
      }
    },

    async assemble(id) {
      try {
        const tx = db.transaction([RECORDINGS, CHUNKS], 'readonly');
        const row = (await request(tx.objectStore(RECORDINGS).get(id))) as StoredRecording | undefined;
        const chunks = (await request(tx.objectStore(CHUNKS).getAll(chunkRange(id)))) as {
          seq: number;
          blob: Blob;
        }[];
        if (!row || chunks.length === 0) return null;
        chunks.sort((a, b) => a.seq - b.seq);
        return new Blob(
          chunks.map((c) => c.blob),
          { type: row.mimeType || 'video/webm' },
        );
      } catch {
        return null;
      }
    },

    async remove(id) {
      try {
        const tx = db.transaction([RECORDINGS, CHUNKS], 'readwrite');
        tx.objectStore(CHUNKS).delete(chunkRange(id));
        tx.objectStore(RECORDINGS).delete(id);
        await done(tx);
      } catch {
        /* Left for the next purge. */
      }
    },

    async purgeSaved(olderThanMs) {
      try {
        const tx = db.transaction(RECORDINGS, 'readonly');
        const rows = (await request(tx.objectStore(RECORDINGS).getAll())) as StoredRecording[];
        const cutoff = Date.now() - olderThanMs;
        for (const row of rows) {
          if (row.saved && row.updatedAt < cutoff) await store.remove(row.id);
        }
      } catch {
        /* Housekeeping only. */
      }
    },
  };
  return store;
}
