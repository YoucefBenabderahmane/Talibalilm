/**
 * Send a large file to R2 in parts, from the browser.
 *
 * One PUT of a long recording is lost whole to a single dropped connection —
 * a Wi-Fi blip, a laptop lid closed for a second — after half an hour of
 * sending, and the browser reports it only as « refused or interrupted ».
 * Here a failure costs one part, which is sent again:
 *
 * - each part is retried, with a growing pause, before the upload gives up;
 * - while the browser is offline nothing is attempted, and sending resumes by
 *   itself when the connection comes back;
 * - a part that stops moving for a minute is cut and sent again, rather than
 *   left to hang;
 * - a part URL that has expired is signed afresh.
 *
 * Parts already in the bucket (`done`) are skipped, which is how a reload, or
 * the same file chosen again after a failure, resumes instead of restarting.
 *
 * Framework-free and given its `put` and `sign` from outside, so the whole of
 * it is tested without a browser or a bucket.
 */

import { partCount, partRange } from './video';

/** PUT one part. Resolves with the HTTP status, 0 for a network failure, -1 when aborted. */
export type PutPart = (
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
) => Promise<number>;

export interface PartUploadOptions {
  file: Blob;
  partSize: number;
  /** Parts the bucket already holds: a resumed upload skips them. */
  done?: Iterable<number>;
  /** URLs for the given parts, signed by the server. */
  sign: (parts: number[]) => Promise<Record<number, string>>;
  /** Bytes in the bucket or on their way, out of the file's size. */
  onProgress?: (sent: number, total: number) => void;
  /** True while sending waits for the connection or for a retry. */
  onWaiting?: (waiting: boolean) => void;
  signal?: AbortSignal;
  /** Parts in flight at once. */
  concurrency?: number;
  /** Tries per part before the upload gives up. Offline time does not count. */
  attempts?: number;
  put?: PutPart;
  /** Pause before retry `n` (1-based), in ms. */
  backoff?: (n: number) => number;
  /** Resolves once the browser is online. */
  online?: () => Promise<void>;
}

/** How many part URLs are asked for at once. */
const SIGN_BATCH = 20;
/** A part with no progress for this long is cut and sent again. */
const STALL_MS = 60_000;

export class PartUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PartUploadError';
  }
}

/** The default PUT: XMLHttpRequest, for its upload progress, with a stall guard. */
export const xhrPut: PutPart = (url, body, onProgress, signal) =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let last = Date.now();
    let settled = false;
    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      window.clearInterval(watch);
      signal.removeEventListener('abort', abort);
      resolve(status);
    };
    const abort = () => {
      xhr.abort();
      finish(-1);
    };
    const watch = window.setInterval(() => {
      if (Date.now() - last > STALL_MS) {
        xhr.abort();
        finish(0);
      }
    }, 5_000);
    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => {
      last = Date.now();
      onProgress(event.loaded);
    };
    xhr.onload = () => finish(xhr.status);
    xhr.onerror = () => finish(0);
    xhr.onabort = () => finish(signal.aborted ? -1 : 0);
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(body);
  });

/** Only a browser that says so is offline: an unknown answer is not a reason to wait. */
function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Resolves when the browser says it is online — at once if it already is. */
export function whenOnline(): Promise<void> {
  if (!isOffline()) return Promise.resolve();
  return new Promise((resolve) => window.addEventListener('online', () => resolve(), { once: true }));
}

const defaultBackoff = (n: number) => Math.min(30_000, 1000 * 2 ** (n - 1)) + Math.random() * 500;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** A status worth trying again: the network, a stall, the server, or throttling. */
function retryable(status: number): boolean {
  return status === 0 || status === 403 || status === 408 || status === 429 || status >= 500;
}

export async function uploadParts({
  file,
  partSize,
  done = [],
  sign,
  onProgress,
  onWaiting,
  signal: outer,
  concurrency = 4,
  attempts = 8,
  put = xhrPut,
  backoff = defaultBackoff,
  online = whenOnline,
}: PartUploadOptions): Promise<void> {
  const total = partCount(file.size, partSize);
  const finished = new Set([...done].filter((n) => n >= 1 && n <= total));
  const queue: number[] = [];
  for (let n = 1; n <= total; n++) if (!finished.has(n)) queue.push(n);

  // One failure stops every part in flight; the caller's cancel does too.
  const stop = new AbortController();
  const signal = stop.signal;
  if (outer?.aborted) stop.abort();
  outer?.addEventListener('abort', () => stop.abort(), { once: true });

  const sizeOf = (n: number) => {
    const { start, end } = partRange(n, file.size, partSize);
    return end - start;
  };
  let settledBytes = [...finished].reduce((sum, n) => sum + sizeOf(n), 0);
  const inFlight = new Map<number, number>();
  const report = () => {
    let moving = 0;
    for (const loaded of inFlight.values()) moving += loaded;
    onProgress?.(Math.min(file.size, settledBytes + moving), file.size);
  };
  report();

  let waiting = 0;
  const setWaiting = (delta: number) => {
    const before = waiting > 0;
    waiting += delta;
    if (before !== waiting > 0) onWaiting?.(waiting > 0);
  };

  // Signed in batches, ahead of the parts that will need them.
  const urls = new Map<number, string>();
  let signing: Promise<void> | null = null;
  const urlFor = async (n: number): Promise<string> => {
    while (!urls.has(n)) {
      if (signing) {
        await signing;
        continue;
      }
      const batch = [n, ...queue.filter((m) => m !== n && !urls.has(m))].slice(0, SIGN_BATCH);
      signing = sign(batch)
        .then((signed) => {
          for (const [k, url] of Object.entries(signed)) urls.set(Number(k), url);
          if (!urls.has(n)) throw new PartUploadError(`no URL was signed for part ${n}`, 0);
        })
        .finally(() => {
          signing = null;
        });
      await signing;
    }
    return urls.get(n) as string;
  };

  const sendPart = async (n: number) => {
    const { start, end } = partRange(n, file.size, partSize);
    const body = file.slice(start, end);
    let status = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (signal.aborted) throw new PartUploadError('the upload was cancelled', -1);
      // Offline time is waiting, not failing: it does not use up the tries.
      if (isOffline()) {
        setWaiting(1);
        await online();
        setWaiting(-1);
      }
      const url = await urlFor(n);
      inFlight.set(n, 0);
      status = await put(
        url,
        body,
        (loaded) => {
          inFlight.set(n, loaded);
          report();
        },
        signal,
      );
      inFlight.delete(n);
      if (status >= 200 && status < 300) {
        settledBytes += end - start;
        report();
        return;
      }
      if (status === -1 || signal.aborted) throw new PartUploadError('the upload was cancelled', -1);
      report();
      if (!retryable(status)) {
        throw new PartUploadError(`R2 refused part ${n} with status ${status}`, status);
      }
      // An expired or refused signature is replaced, not reused.
      if (status === 403) urls.delete(n);
      if (attempt < attempts) {
        setWaiting(1);
        await sleep(backoff(attempt), signal);
        setWaiting(-1);
      }
    }
    throw new PartUploadError(
      `part ${n} could not be sent after ${attempts} tries (last answer: ${
        status === 0 ? 'no connection' : `HTTP ${status}`
      })`,
      status,
    );
  };

  const worker = async () => {
    for (;;) {
      const n = queue.shift();
      if (n === undefined) return;
      await sendPart(n);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  } catch (error) {
    stop.abort();
    throw error;
  } finally {
    if (waiting > 0) onWaiting?.(false);
  }
}
