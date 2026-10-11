'use client';

/**
 * A PDF opened on the teacher's own machine, for presenting live.
 *
 * The old path rendered EVERY page to an image, encoded it, and uploaded it to
 * R2 before the class could see page one — minutes for a 500-page deck, heavy
 * memory, and pages that came out black when the browser ran short. Zoom does
 * not do that: it shows the page on the presenter's screen and streams it.
 *
 * This is that. The file is opened in a worker (pdf.js parses only the cross-
 * reference table up front, so 500 pages open in about a second), and a page is
 * drawn only when somebody needs it: the page on stage, the next ones ahead of
 * the teacher, and the thumbnails the panel scrolls into view.
 *
 * One worker per document and one request at a time, in priority order — the
 * page on stage never waits behind a thumbnail. A worker that stops answering
 * fails its request by a deadline instead of freezing the deck.
 */

export type RenderPriority = 'stage' | 'ahead' | 'thumb';

const RANK: Record<RenderPriority, number> = { stage: 0, ahead: 1, thumb: 2 };
const OPEN_DEADLINE_MS = 60_000;
const RENDER_DEADLINE_MS = 30_000;

export interface LiveDocument {
  pages: number;
  /** A page fitted inside width × height, or null when it could not be drawn. */
  render(page: number, width: number, height: number, priority: RenderPriority): Promise<ImageBitmap | null>;
  close(): void;
}

export class LiveDocumentError extends Error {
  constructor(
    readonly reason: 'password' | 'corrupt' | 'engine',
    detail: string,
  ) {
    super(detail);
    this.name = 'LiveDocumentError';
  }
}

/** True when this browser can draw pages off the main thread and stream them. */
export function liveDeckSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}

interface Job {
  page: number;
  width: number;
  height: number;
  rank: number;
  seq: number;
  resolve: (bitmap: ImageBitmap | null) => void;
  reject: (error: Error) => void;
}

type Reply =
  | { type: 'ready'; id: number; pages: number }
  | { type: 'bitmap'; id: number; page: number; bitmap: ImageBitmap }
  | { type: 'failed'; id: number; page: number }
  | { type: 'error'; id: number; detail: string };

function reasonOf(detail: string): 'password' | 'corrupt' | 'engine' {
  if (/PasswordException/i.test(detail)) return 'password';
  if (/InvalidPDFException|Invalid PDF/i.test(detail)) return 'corrupt';
  return 'engine';
}

export async function openLiveDocument(file: File): Promise<LiveDocument> {
  const worker = new Worker(new URL('./pdf-render.worker.ts', import.meta.url), { type: 'module' });
  let nextId = 0;
  let closed = false;
  const waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();

  const failAll = (error: Error) => {
    for (const entry of waiting.values()) entry.reject(error);
    waiting.clear();
  };
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const entry = waiting.get(event.data.id);
    if (!entry) {
      // A reply to a request that already timed out: its bitmap is not ours
      // to keep, and holding it would leak GPU memory.
      if (event.data.type === 'bitmap') event.data.bitmap.close();
      return;
    }
    waiting.delete(event.data.id);
    if (event.data.type === 'error') entry.reject(new Error(event.data.detail));
    else entry.resolve(event.data);
  };
  worker.onerror = (event) => failAll(new Error(event.message || 'the pdf worker failed'));

  const call = (message: Record<string, unknown>, deadlineMs: number) =>
    new Promise<Reply>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`the pdf worker did not answer within ${Math.round(deadlineMs / 1000)}s`));
      }, deadlineMs);
      waiting.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.postMessage({ ...message, id });
    });

  let pages: number;
  try {
    // The File itself goes to the worker: shared, not copied, so the room's
    // thread never holds a second copy of a 200 MB document.
    const reply = await call({ type: 'open', file, baseName: 'live' }, OPEN_DEADLINE_MS);
    if (reply.type !== 'ready') throw new Error('unexpected worker reply');
    pages = reply.pages;
  } catch (thrown) {
    worker.terminate();
    const detail = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    throw new LiveDocumentError(reasonOf(detail), detail);
  }

  const queue: Job[] = [];
  let seq = 0;
  let busy = false;

  const pump = () => {
    if (busy || closed || queue.length === 0) return;
    // Highest priority first; within one priority, the newest request — the
    // thumbnail just scrolled into view matters more than one scrolled past.
    queue.sort((a, b) => a.rank - b.rank || b.seq - a.seq);
    const job = queue.shift()!;
    busy = true;
    call({ type: 'bitmap', page: job.page, width: job.width, height: job.height }, RENDER_DEADLINE_MS)
      .then((reply) => job.resolve(reply.type === 'bitmap' ? reply.bitmap : null))
      .catch((error: Error) => job.reject(error))
      .finally(() => {
        busy = false;
        pump();
      });
  };

  return {
    pages,
    render(page, width, height, priority) {
      if (closed) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        queue.push({ page, width, height, rank: RANK[priority], seq: seq++, resolve, reject });
        pump();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const job of queue.splice(0)) job.resolve(null);
      failAll(new Error('document closed'));
      worker.postMessage({ type: 'close', id: ++nextId });
      // Give the worker a moment to free pdf.js, then make sure it is gone.
      setTimeout(() => worker.terminate(), 2_000);
    },
  };
}

/** An image file as a one-page "document", drawn the same way as a PDF page. */
export async function openLiveImage(file: File): Promise<LiveDocument> {
  let source: ImageBitmap;
  try {
    source = await createImageBitmap(file);
  } catch (thrown) {
    const detail = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    throw new LiveDocumentError('corrupt', detail);
  }
  let closed = false;
  return {
    pages: 1,
    async render(_page, width, height) {
      if (closed) return null;
      const fit = Math.min(1, width / source.width, height / source.height);
      return createImageBitmap(source, {
        resizeWidth: Math.max(1, Math.round(source.width * fit)),
        resizeHeight: Math.max(1, Math.round(source.height * fit)),
        resizeQuality: 'high',
      });
    },
    close() {
      closed = true;
      source.close();
    },
  };
}
