'use client';

/**
 * A PDF becomes a stack of images, in the teacher's own browser.
 *
 * The alternative was storing the PDF and rendering it in every viewer's
 * browser — a PDF engine shipped to forty students, the whole document fetched
 * for each of them, and a second kind of slide for the student side to learn.
 * Converting once, at upload, keeps the rule that a slide is an image, so the
 * byte sniffing, the database constraints and the student's page are untouched.
 *
 * Three things here are the result of this failing in production rather than of
 * taste:
 *
 *   * The WORKER is constructed explicitly, as a module worker. pdf.js ships an
 *     ESM worker and, left to load it itself, it can start one as a classic
 *     worker — which fails to parse the moment it meets `import`, and surfaces
 *     as "this PDF could not be read" about a PDF that is perfectly fine. If
 *     the browser will not give us a module worker at all, we fall back to
 *     running on the main thread, which is slower and always works.
 *
 *   * The ENGINE is the modern build first, the legacy build second. The legacy
 *     build exists for browsers a year or two old and is measurably slower at
 *     parsing and rendering; trying it second means a current browser gets the
 *     fast path and an old one still gets slides.
 *
 *   * PAGES RENDER IN PARALLEL. One worker drawing a hundred pages in order is
 *     the slowest part of a large deck, and it is CPU-bound — so the pages are
 *     dealt to a small pool and a reorder buffer keeps the deck in page order
 *     however the renders finish.
 *
 *   * Errors are not flattened. A password, a corrupt file and a worker that
 *     would not start are three different problems with three different things
 *     for the teacher to do, and the caller is told which.
 */

import type * as PdfJs from 'pdfjs-dist';
import { PageReorder, pdfTargetWidth, pdfWorkerCount } from './pdf-plan';

export interface PdfProgress {
  page: number;
  pages: number;
}

/** Why a PDF could not be turned into slides. Distinct on purpose. */
export type PdfFailure = 'password' | 'corrupt' | 'engine' | 'empty';

export class PdfError extends Error {
  constructor(
    readonly reason: PdfFailure,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'PdfError';
  }
}

type PdfModule = typeof PdfJs;
type LoadingTask = ReturnType<PdfModule['getDocument']>;
type DocumentProxy = Awaited<LoadingTask['promise']>;

/** One pdf.js build: the engine, its worker, and the inline worker bundle. */
interface Engine {
  load: () => Promise<unknown>;
  workerUrl: () => URL;
  inline: () => Promise<unknown>;
}

const ENGINES: Engine[] = [
  {
    load: () => import('pdfjs-dist/build/pdf.mjs'),
    workerUrl: () => new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
    inline: () => import('pdfjs-dist/build/pdf.worker.min.mjs'),
  },
  {
    load: () => import('pdfjs-dist/legacy/build/pdf.mjs'),
    workerUrl: () => new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url),
    inline: () => import('pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
  },
];

/**
 * A worker, or null when the browser refuses to start one.
 *
 * Whether a module worker can be started from a bundled URL depends on the
 * bundler, the browser and the page's own headers — three things that can each
 * change without us touching this file, and whose failure looked exactly like a
 * broken PDF. So the worker is an attempt, not an assumption.
 */
function makeWorker(url: URL): Worker | null {
  try {
    return new Worker(url, { type: 'module' });
  } catch {
    return null;
  }
}

interface OpenedDocument {
  task: LoadingTask;
  document_: DocumentProxy;
  /** Null when this document is running inline on the main thread. */
  worker: Worker | null;
}

/** A file problem is the teacher's to fix; anything else is worth retrying. */
function fileProblem(thrown: unknown): PdfFailure | null {
  const name = (thrown as { name?: string })?.name ?? '';
  if (name === 'PasswordException') return 'password';
  if (name === 'InvalidPDFException') return 'corrupt';
  return null;
}

async function openWithWorker(
  pdfjs: PdfModule,
  data: Uint8Array,
  worker: Worker,
): Promise<OpenedDocument> {
  // The document binds to whichever worker is in the global slot at the moment
  // it is created, which is how several documents each get their own thread.
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  const task = pdfjs.getDocument({ data, useWorkerFetch: false });
  return { task, document_: await task.promise, worker };
}

/**
 * Run the engine on the main thread instead.
 *
 * Importing the worker bundle registers it globally, and pdf.js then uses it
 * without a Worker at all. The tab is busy while a deck converts — which is a
 * few seconds at upload time, and is the right trade against refusing the file.
 */
async function openInline(
  pdfjs: PdfModule,
  engine: Engine,
  data: Uint8Array,
): Promise<OpenedDocument> {
  pdfjs.GlobalWorkerOptions.workerPort = null;
  pdfjs.GlobalWorkerOptions.workerSrc = '';
  await engine.inline();
  const task = pdfjs.getDocument({ data, useWorkerFetch: false });
  return { task, document_: await task.promise, worker: null };
}

/**
 * Open one document, on a worker if one can be had.
 *
 * The worker attempt gets a copy so the original bytes survive for the inline
 * retry — pdf.js transfers the buffer it is handed, leaving the original
 * detached and a retry reading zero bytes.
 */
async function openDocument(
  pdfjs: PdfModule,
  engine: Engine,
  bytes: Uint8Array,
): Promise<OpenedDocument> {
  const worker = makeWorker(engine.workerUrl());
  if (worker) {
    try {
      return await openWithWorker(pdfjs, bytes.slice(), worker);
    } catch (thrown) {
      worker.terminate();
      const problem = fileProblem(thrown);
      if (problem) throw new PdfError(problem, describe(thrown));
      // Not the file, then: the worker would not run. Fall through to inline.
    }
  }

  try {
    return await openInline(pdfjs, engine, bytes);
  } catch (thrown) {
    throw new PdfError(fileProblem(thrown) ?? 'engine', describe(thrown));
  }
}

export interface PdfPage {
  file: File;
  page: number;
  pages: number;
}

export interface PdfPageOptions {
  maxPages?: number;
  onProgress?: (progress: PdfProgress) => void;
  /**
   * Each page as it is rendered, in order.
   *
   * Not a `File[]` on purpose. A hundred-page deck held as PNGs is hundreds of
   * megabytes and nothing leaves the tab until the last page is drawn; handing
   * each page over as it exists lets the caller upload it while the next one
   * renders. Returning a promise slows the loop, which is how a caller applies
   * backpressure when uploads fall behind.
   */
  onPage: (page: PdfPage) => void | Promise<void>;
}

/** One page as it comes back from a worker. */
interface PoolPage {
  blob: Blob;
  name: string;
}

interface PoolWorker {
  open(bytes: ArrayBuffer, baseName: string): Promise<number>;
  render(page: number, width: number): Promise<PoolPage | null>;
  close(): void;
  terminate(): void;
}

type WorkerReply =
  | { type: 'ready'; id: number; pages: number }
  | { type: 'rendered'; id: number; page: number; blob: Blob; name: string }
  | { type: 'failed'; id: number; page: number }
  | { type: 'error'; id: number; detail: string };

/**
 * How long a worker may take before its call is abandoned.
 *
 * A worker that never answers — a page the engine cannot finish, a thread the
 * browser quietly killed — used to leave the upload's busy counter raised
 * forever: "Envoi…" with nothing behind it. The deadline turns that into a
 * named failure with the page number. Opening is generous enough to cover the
 * first parse of a very large document.
 */
const OPEN_DEADLINE_MS = 30_000;
const RENDER_DEADLINE_MS = 60_000;

/**
 * One worker, addressed by request id.
 *
 * Every call gets a promise; a worker that dies rejects whatever it was holding
 * rather than leaving the deck waiting on a reply that will never come.
 */
function spawnPoolWorker(): PoolWorker {
  const worker = new Worker(new URL('./pdf-render.worker.ts', import.meta.url), {
    type: 'module',
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void }
  >();

  const fail = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.type === 'error') entry.reject(new Error(event.data.detail));
    else entry.resolve(event.data);
  };
  worker.onerror = (event) => fail(new Error(event.message || 'the pdf worker failed'));

  const call = (
    message: Record<string, unknown>,
    transfer: Transferable[],
    deadlineMs: number,
  ) =>
    new Promise<WorkerReply>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(`the pdf worker did not answer within ${Math.round(deadlineMs / 1000)}s`),
        );
      }, deadlineMs);
      pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.postMessage({ ...message, id }, transfer);
    });

  return {
    async open(bytes, name) {
      const reply = await call({ type: 'open', bytes, baseName: name }, [bytes], OPEN_DEADLINE_MS);
      if (reply.type !== 'ready') throw new Error('unexpected worker reply');
      return reply.pages;
    },
    async render(page, width) {
      const reply = await call({ type: 'render', page, width }, [], RENDER_DEADLINE_MS);
      if (reply.type === 'rendered') return { blob: reply.blob, name: reply.name };
      if (reply.type === 'failed') return null;
      throw new Error('unexpected worker reply');
    },
    close: () => {
      worker.postMessage({ type: 'close', id: ++nextId });
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * The deck, dealt to a pool of workers.
 *
 * Each worker asks for the next page when it is free, so one slow page does not
 * hold a fast one behind it; the reorder buffer still guarantees the deck comes
 * out 1, 2, 3. Uploads are awaited inside the loop, which is the backpressure —
 * a worker waits for the pages behind it to land rather than turning a whole
 * deck into memory at once.
 */
class PdfWorkerPool {
  /** Pages actually handed to the caller — the number a fallback must respect. */
  delivered = 0;
  private readonly workers: PoolWorker[] = [];

  constructor(
    private readonly file: File,
    private readonly options: PdfPageOptions,
  ) {}

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
  }

  async run(): Promise<number> {
    const cores = typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency ?? 4);
    const source = new Uint8Array(await this.file.arrayBuffer());
    // The PDF's own name, without the extension: `deck.pdf` becomes `deck-01`,
    // the same as the main-thread path produces.
    const baseName = this.file.name.replace(/\.pdf$/i, '');

    const first = this.spawn();
    const documentPages = await first.open(source.slice().buffer, baseName);
    const total = Math.min(documentPages, this.options.maxPages ?? 500);
    if (total === 0) throw new PdfError('empty', 'no pages');

    const width = pdfTargetWidth(total);
    const wanted = pdfWorkerCount(cores, this.file.size, total);
    const rest = Array.from({ length: wanted - 1 }, () => this.spawn());
    await Promise.all(rest.map((worker) => worker.open(source.slice().buffer, baseName)));
    const workers = [first, ...rest];

    let next = 1;
    let completed = 0;
    const reorder = new PageReorder<{ page: number; file: File }>();
    let emitChain: Promise<void> = Promise.resolve();

    const emit = (page: number, file: File): Promise<void> => {
      emitChain = emitChain.then(async () => {
        await this.options.onPage({ file, page, pages: total });
        this.delivered += 1;
      });
      return emitChain;
    };

    const drive = async (worker: PoolWorker): Promise<void> => {
      for (;;) {
        if (next > total) {
          worker.close();
          return;
        }
        const page = next;
        next += 1;
        const rendered = await worker.render(page, width);
        completed += 1;
        this.options.onProgress?.({ page: completed, pages: total });
        if (rendered) {
          const file = new File([rendered.blob], rendered.name, { type: rendered.blob.type });
          for (const item of reorder.push(page, { page, file })) await emit(item.page, item.file);
        } else {
          for (const item of reorder.skip(page)) await emit(item.page, item.file);
        }
      }
    };

    await Promise.all(workers.map(drive));
    await emitChain;
    return this.delivered;
  }

  private spawn(): PoolWorker {
    const worker = spawnPoolWorker();
    this.workers.push(worker);
    return worker;
  }
}

/**
 * Render a PDF, one page at a time, handing each page over as it exists.
 *
 * Resolves with how many pages were delivered. The canvas is discarded before
 * the next page starts, so memory holds a page or two rather than a deck.
 *
 * The worker pool goes first: it is the only path that leaves the room's thread
 * free while a deck converts. Anything it cannot do — a browser without module
 * workers or OffscreenCanvas, a PDF that only the main-thread engines can open —
 * falls through to the engines below, unchanged. A failure after pages have
 * already been handed over is not retried: the deck and its catalogue are
 * written from what `onPage` delivered, and rendering a page twice would
 * register it twice.
 */
export async function pdfPages(file: File, options: PdfPageOptions): Promise<number> {
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    const pool = new PdfWorkerPool(file, options);
    try {
      return await pool.run();
    } catch (thrown) {
      if (pool.delivered > 0) {
        throw thrown instanceof PdfError ? thrown : new PdfError('engine', describe(thrown));
      }
    } finally {
      pool.dispose();
    }
  }

  let lastError: unknown = null;

  for (const engine of ENGINES) {
    let pdfjs: PdfModule;
    try {
      pdfjs = (await engine.load()) as unknown as PdfModule;
    } catch (thrown) {
      lastError = thrown;
      continue;
    }

    // A fresh copy per engine: the inline attempt transfers the buffer, and the
    // next engine must not be handed an empty one.
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      return await renderDeck(pdfjs, engine, bytes, file, options);
    } catch (thrown) {
      // A file problem is the teacher's to fix; another engine will not help.
      if (thrown instanceof PdfError && thrown.reason !== 'engine') throw thrown;
      lastError = thrown;
    }
  }

  throw new PdfError('engine', describe(lastError));
}

async function renderDeck(
  pdfjs: PdfModule,
  engine: Engine,
  bytes: Uint8Array,
  file: File,
  options: PdfPageOptions,
): Promise<number> {
  const primary = await openDocument(pdfjs, engine, bytes);
  const pages = Math.min(primary.document_.numPages, options.maxPages ?? 500);
  if (pages === 0) {
    await primary.task.destroy().catch(() => {});
    throw new PdfError('empty', 'no pages');
  }

  const width = pdfTargetWidth(pages);
  const baseName = file.name.replace(/\.pdf$/i, '');
  const wanted = pdfWorkerCount(
    typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency ?? 4),
    file.size,
    pages,
  );

  const extras: OpenedDocument[] = [];
  if (wanted > 1 && primary.worker) {
    // Each extra worker needs its own document, and therefore its own copy of
    // the file — the primary's copy went to its worker.
    const spare = new Uint8Array(await file.arrayBuffer());
    for (let i = 1; i < wanted; i += 1) {
      const worker = makeWorker(engine.workerUrl());
      if (!worker) break;
      try {
        extras.push(await openWithWorker(pdfjs, spare.slice(), worker));
      } catch {
        worker.terminate();
        break;
      }
    }
  }

  const documents = [primary, ...extras];
  let delivered = 0;

  try {
    if (documents.length === 1) {
      for (let n = 1; n <= pages; n += 1) {
        options.onProgress?.({ page: n, pages });
        const rendered = await renderPage(primary.document_, n, width, baseName);
        if (rendered) {
          await options.onPage({ file: rendered, page: n, pages });
          delivered += 1;
        }
      }
    } else {
      delivered = await renderParallel(documents, pages, width, baseName, options);
    }
  } catch (thrown) {
    if (thrown instanceof PdfError) throw thrown;
    throw new PdfError('engine', describe(thrown));
  } finally {
    // The loading task, not the document: `destroy()` is what shuts a worker
    // down, and one left running per upload accumulates.
    await Promise.all(documents.map((doc) => doc.task.destroy().catch(() => {})));
  }

  return delivered;
}

/**
 * Pages dealt to the pool, released in order.
 *
 * Awaiting the emission chain is the backpressure: a worker that has finished
 * a page waits for the uploads behind it rather than filling memory with
 * finished images. Progress is reported as pages completed, which is
 * monotonic even though the pages themselves finish out of order.
 */
async function renderParallel(
  documents: OpenedDocument[],
  pages: number,
  width: number,
  baseName: string,
  options: PdfPageOptions,
): Promise<number> {
  const reorder = new PageReorder<{ page: number; file: File }>();
  let next = 1;
  let completed = 0;
  let delivered = 0;
  let failure: unknown = null;
  let emitChain: Promise<void> = Promise.resolve();

  const emit = (file: File, page: number): Promise<void> => {
    emitChain = emitChain.then(async () => {
      await options.onPage({ file, page, pages });
      delivered += 1;
    });
    return emitChain;
  };

  const run = async (document_: DocumentProxy) => {
    for (;;) {
      if (failure) return;
      const n = next;
      next += 1;
      if (n > pages) return;

      try {
        const rendered = await renderPage(document_, n, width, baseName);
        completed += 1;
        options.onProgress?.({ page: completed, pages });
        if (rendered) {
          for (const item of reorder.push(n, { page: n, file: rendered })) {
            await emit(item.file, item.page);
          }
        } else {
          // A page the browser could not encode, even retried smaller. Mark it
          // missing so the pages behind it are released rather than held
          // forever — the silent truncation this buffer used to cause.
          for (const item of reorder.skip(n)) {
            await emit(item.file, item.page);
          }
        }
      } catch (thrown) {
        failure = thrown;
        return;
      }
    }
  };

  await Promise.all(documents.map((doc) => run(doc.document_)));
  await emitChain;

  if (failure) {
    if (failure instanceof PdfError) throw failure;
    throw new PdfError('engine', describe(failure));
  }
  return delivered;
}

/**
 * One page as a file, or null when the canvas would not encode.
 *
 * A failed encode is nearly always memory: the browser refuses `toBlob` rather
 * than throwing. So the page is drawn again at half the width before it is
 * given up on — a softer slide beats a missing one — and only then does it
 * return null, which the caller records as a page that will never arrive.
 */
async function renderPage(
  document_: DocumentProxy,
  n: number,
  width: number,
  baseName: string,
): Promise<File | null> {
  const page = await document_.getPage(n);
  try {
    const unscaled = page.getViewport({ scale: 1 });

    for (const factor of [1, 0.5]) {
      const viewport = page.getViewport({ scale: (width * factor) / unscaled.width });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new PdfError('engine', 'no 2d canvas context');

      // White behind the page: a PDF with a transparent background would
      // otherwise come out as black text on black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Annotation mode 0: a slide is a picture of a page, and a link or a form
      // field drawn into it is work nobody asked for.
      await page.render({ canvas, viewport, annotationMode: 0 }).promise;

      const blob = await encodePage(canvas);
      if (blob) {
        const extension =
          blob.type === 'image/webp' ? 'webp' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
        return new File([blob], `${baseName}-${String(n).padStart(2, '0')}.${extension}`, {
          type: blob.type,
        });
      }

      // Release the pixels before the retry; the retry exists because the
      // browser was out of room for them.
      canvas.width = 0;
      canvas.height = 0;
    }

    return null;
  } finally {
    page.cleanup();
  }
}

/**
 * Encode a rendered page, WebP first.
 *
 * PNG was the original choice and it is the wrong one for slides: a page at
 * this width is one to three megabytes, which the teacher then waits to upload
 * a hundred times over. WebP is a fraction of that at the same legibility. A
 * browser that cannot encode it returns PNG from `toBlob` itself — the type is
 * read from the blob, never assumed, so the caller always declares what it
 * actually has.
 */
async function encodePage(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const webp = await toBlob(canvas, 'image/webp', 0.85);
  if (webp) return webp;
  const jpeg = await toBlob(canvas, 'image/jpeg', 0.9);
  if (jpeg) return jpeg;
  return toBlob(canvas, 'image/png');
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function describe(thrown: unknown): string {
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`;
  return String(thrown);
}
