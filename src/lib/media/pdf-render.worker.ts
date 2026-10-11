import type * as PdfJs from 'pdfjs-dist';

/**
 * The PDF engine, on a thread of its own.
 *
 * pdf.js parses in its own worker but DRAWS on the thread that calls
 * `page.render` — and that thread used to be the room's. A hundred-page deck
 * therefore spent the whole conversion inside the class: the interface stuttered
 * and the recorder, which paints its frame from `requestAnimationFrame`, stopped
 * producing frames while the teacher was recording a lesson. The button looked
 * frozen because, for practical purposes, it was.
 *
 * So the engine lives here instead. This worker loads pdf.js inline — its own
 * thread is the "main thread" as far as the library is concerned — draws each
 * page into an OffscreenCanvas, encodes it, and posts the bytes back. The room's
 * thread only coordinates: it hands out page numbers and uploads what comes
 * back. Nothing heavy touches it.
 *
 * The DOM factories pdf.js would pick by default are replaced: `document` does
 * not exist here, and `DOMCanvasFactory`/`DOMFilterFactory` reach for it on the
 * first pattern, mask or blend group. `disableFontFace` draws glyphs as paths
 * rather than asking the page for a `FontFace`, which is the same trade the
 * library makes for Node.
 */

type PdfModule = typeof PdfJs;
type DocumentProxy = Awaited<ReturnType<PdfModule['getDocument']>['promise']>;

interface Engine {
  load: () => Promise<unknown>;
  inline: () => Promise<unknown>;
}

const ENGINES: Engine[] = [
  {
    load: () => import('pdfjs-dist/build/pdf.mjs'),
    inline: () => import('pdfjs-dist/build/pdf.worker.min.mjs'),
  },
  {
    load: () => import('pdfjs-dist/legacy/build/pdf.mjs'),
    inline: () => import('pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
  },
];

/**
 * A canvas factory pdf.js can use without a document.
 *
 * The shape is the library's own `BaseCanvasFactory`: `create`, `reset`,
 * `destroy`, over an OffscreenCanvas. Pattern tiles, soft-mask groups and the
 * transparent canvas behind a blend group all come through here.
 */
class OffscreenCanvasFactory {
  create(width: number, height: number): { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D } {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2d context');
    return { canvas, context };
  }

  reset(entry: { canvas: OffscreenCanvas }, width: number, height: number): void {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    entry.canvas.width = width;
    entry.canvas.height = height;
  }

  destroy(entry: { canvas: OffscreenCanvas | null; context?: unknown }): void {
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
    entry.canvas = null;
    entry.context = null;
  }
}

/**
 * The no-filter filter factory.
 *
 * The real one builds SVG filters in a hidden document. Off a document there
 * are no filters, so the library's own base answers: `"none"`. A soft mask or a
 * blend group renders plainly rather than crashing the conversion.
 */
class PlainFilterFactory {
  addFilter(): string {
    return 'none';
  }
  addHCMFilter(): string {
    return 'none';
  }
  addAlphaFilter(): string {
    return 'none';
  }
  addLuminosityFilter(): string {
    return 'none';
  }
  addKnockoutFilter(): string {
    return 'none';
  }
  addHighlightHCMFilter(): string {
    return 'none';
  }
  addSelectionHCMFilter(): string {
    return 'none';
  }
  addSelectionFilter(): string {
    return 'none';
  }
  createSelectionStyle(): null {
    return null;
  }
  destroy(): void {}
}

interface InOpen {
  type: 'open';
  id: number;
  /**
   * The File itself, not its bytes. A File is shared with the worker rather
   * than copied, so the room's thread never allocates a second copy of a
   * two-hundred-megabyte document — this thread reads what it needs.
   */
  file: File;
  baseName: string;
}
interface InRender {
  type: 'render';
  id: number;
  page: number;
  width: number;
}
/**
 * One page as a ready-to-draw bitmap, for the live deck: no encoding, no
 * upload — the room draws it straight onto the slide it broadcasts. Fitted
 * inside `width` × `height` so a portrait page is not drawn 1,920 px wide.
 */
interface InBitmap {
  type: 'bitmap';
  id: number;
  page: number;
  width: number;
  height: number;
}
interface InClose {
  type: 'close';
  id: number;
}
type InMessage = InOpen | InRender | InBitmap | InClose;

type OutMessage =
  | { type: 'ready'; id: number; pages: number }
  | { type: 'rendered'; id: number; page: number; blob: Blob; name: string }
  | { type: 'bitmap'; id: number; page: number; bitmap: ImageBitmap }
  | { type: 'failed'; id: number; page: number }
  | { type: 'error'; id: number; detail: string };

const scope = self as unknown as {
  postMessage: (message: OutMessage, transfer?: Transferable[]) => void;
  close: () => void;
  onmessage: ((event: MessageEvent<InMessage>) => void) | null;
};

const post = (message: OutMessage, transfer?: Transferable[]) => scope.postMessage(message, transfer);

let document_: DocumentProxy | null = null;
/** The loading task owns the engine: `destroy()` is what shuts it down. */
let task_: { destroy: () => Promise<void> } | null = null;
let baseName = 'slide';

/**
 * Open one document, modern engine first.
 *
 * Same order as the main-thread path: the modern build is measurably faster and
 * the legacy one is there for browsers a year or two old. A file problem is the
 * teacher's; the caller sees it as an error either way and the main thread can
 * still take over.
 */
async function open(file: File): Promise<number> {
  let lastError: unknown = null;

  for (const engine of ENGINES) {
    let pdfjs: PdfModule;
    try {
      pdfjs = (await engine.load()) as unknown as PdfModule;
    } catch (thrown) {
      lastError = thrown;
      continue;
    }

    try {
      // The inline bundle registers the handler on `globalThis`, and pdf.js
      // then runs it on this thread rather than asking for a nested worker.
      pdfjs.GlobalWorkerOptions.workerPort = null;
      pdfjs.GlobalWorkerOptions.workerSrc = '';
      await engine.inline();

      const task = pdfjs.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        useWorkerFetch: false,
        disableFontFace: true,
        useSystemFonts: false,
        CanvasFactory: OffscreenCanvasFactory as never,
        FilterFactory: PlainFilterFactory as never,
      });
      const opened = await task.promise;
      document_ = opened;
      task_ = task;
      return opened.numPages;
    } catch (thrown) {
      lastError = thrown;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * One page, encoded, or null when the canvas would not encode.
 *
 * Identical to the main-thread renderer, including the half-width retry: a
 * failed encode is nearly always memory, and a softer slide beats a missing one.
 */
async function renderPage(
  pageNumber: number,
  width: number,
): Promise<{ blob: Blob; name: string } | null> {
  if (!document_) throw new Error('no document');
  const page = await document_.getPage(pageNumber);
  try {
    const unscaled = page.getViewport({ scale: 1 });

    for (const factor of [1, 0.5]) {
      const viewport = page.getViewport({ scale: (width * factor) / unscaled.width });
      const canvas = new OffscreenCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No 2d context');

      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      // The cast is the type surface lagging the runtime: the render task asks
      // the canvas for a 2d context, which an OffscreenCanvas answers.
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
        annotationMode: 0,
      }).promise;

      const blob = await encode(canvas);
      if (blob) {
        const extension =
          blob.type === 'image/webp' ? 'webp' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
        return {
          blob,
          name: `${baseName}-${String(pageNumber).padStart(2, '0')}.${extension}`,
        };
      }

      canvas.width = 0;
      canvas.height = 0;
    }

    return null;
  } finally {
    page.cleanup();
  }
}

/**
 * One page as an ImageBitmap fitted inside the box, or null.
 *
 * The canvas is checked before it is handed over: under memory pressure a
 * browser can lose a canvas mid-render and hand back an empty one, which a
 * dark stage shows as a black slide. The page is filled white first, so an
 * empty corner pixel means the canvas was lost — retried at half size, then
 * reported as failed rather than shown black.
 */
async function renderBitmap(
  pageNumber: number,
  width: number,
  height: number,
): Promise<ImageBitmap | null> {
  if (!document_) throw new Error('no document');
  const page = await document_.getPage(pageNumber);
  try {
    const unscaled = page.getViewport({ scale: 1 });
    const fit = Math.min(width / unscaled.width, height / unscaled.height);

    for (const factor of [1, 0.5]) {
      const viewport = page.getViewport({ scale: fit * factor });
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(viewport.width)),
        Math.max(1, Math.round(viewport.height)),
      );
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No 2d context');

      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
        annotationMode: 0,
      }).promise;

      const probe = context.getImageData(0, 0, 1, 1).data;
      if (probe[3] !== 0) return canvas.transferToImageBitmap();

      canvas.width = 0;
      canvas.height = 0;
    }
    return null;
  } finally {
    page.cleanup();
  }
}

/** WebP first, then JPEG, then PNG — the same order, and reason, as the main thread. */
async function encode(canvas: OffscreenCanvas): Promise<Blob | null> {
  const attempts: { type: string; quality?: number }[] = [
    { type: 'image/webp', quality: 0.85 },
    { type: 'image/jpeg', quality: 0.9 },
    { type: 'image/png' },
  ];
  for (const attempt of attempts) {
    try {
      const blob = await canvas.convertToBlob(attempt);
      if (blob.type === attempt.type) return blob;
    } catch {
      // This encoding is not available; the next one is.
    }
  }
  return null;
}

scope.onmessage = (event) => {
  const message = event.data;
  void (async () => {
    try {
      if (message.type === 'open') {
        baseName = message.baseName;
        const pages = await open(message.file);
        post({ type: 'ready', id: message.id, pages });
        return;
      }
      if (message.type === 'render') {
        const rendered = await renderPage(message.page, message.width);
        if (rendered) {
          post({
            type: 'rendered',
            id: message.id,
            page: message.page,
            blob: rendered.blob,
            name: rendered.name,
          });
        } else {
          post({ type: 'failed', id: message.id, page: message.page });
        }
        return;
      }
      if (message.type === 'bitmap') {
        const bitmap = await renderBitmap(message.page, message.width, message.height);
        if (bitmap) {
          post({ type: 'bitmap', id: message.id, page: message.page, bitmap }, [bitmap]);
        } else {
          post({ type: 'failed', id: message.id, page: message.page });
        }
        return;
      }
      if (message.type === 'close') {
        const task = task_;
        document_ = null;
        task_ = null;
        if (task) await task.destroy().catch(() => {});
        scope.close();
      }
    } catch (thrown) {
      post({
        type: 'error',
        id: message.id,
        detail: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
      });
    }
  })();
};
