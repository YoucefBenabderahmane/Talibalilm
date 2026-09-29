'use client';

import { useCallback, useRef, useState } from 'react';
import { confirmSlides, requestSlideUploads } from '@/app/actions/slides';
import { MAX_IMAGE_BYTES } from '@/lib/media/image';
import { runPool } from '@/lib/media/pool';
import { classifyUpload } from '@/lib/media/upload-kind';
import { PdfError } from '@/lib/media/pdf';

/**
 * Adding slides, from either the preparation screen or the room.
 *
 * One hook so the two surfaces cannot drift: the same formats, the same
 * refusals, the same two-step upload. A teacher who learns it before the lesson
 * does not learn it again during one.
 *
 * A PDF is expanded into one image per page before anything is uploaded. That
 * is deliberate and it is where the whole design holds together — the server
 * still only ever accepts a PNG, JPEG or WebP, so the byte sniffing and the
 * database constraints did not have to be relaxed to gain a feature.
 *
 * A large deck is the case this is built around. Pages are uploaded as they
 * are rendered, several PUTs are in flight at once, and each group of pages is
 * signed and confirmed in ONE server round trip — a hundred-page PDF used to
 * cost two hundred of them before a byte moved. Conversion and upload overlap,
 * so the first slide is on screen while the rest of the deck is still being
 * drawn, and memory holds a couple of pages rather than all of them.
 */
export interface SlideUploadState {
  /** Files currently in flight, and which page of a PDF is being converted. */
  busy: number;
  converting: { page: number; pages: number } | null;
  error: string | null;
  /**
   * The underlying exception, when there is one.
   *
   * Shown to the teacher because the alternative has cost several rounds: a
   * single "could not be read" stood for a password, a corrupt file and a
   * worker that would not start, and only one of those was ever true.
   */
  detail: string | null;
  clearError: () => void;
  upload: (files: FileList | File[]) => Promise<void>;
}

export interface SlideUploadHandlers {
  /** The deck needs re-reading from the server (the admin preparation screen). */
  onDone?: () => void;
  /**
   * One slide landed, with its position in this batch. The room uses this to
   * put the new page in front of the class the moment it is up, without
   * rebuilding the page a lesson is happening on.
   */
  onAdded?: (slide: { id: string; url: string | null; filename: string }, index: number) => void;
}

/** Pages signed and confirmed in one round trip. */
const BATCH = 12;
/** PUTs in flight at once. Wider saturates a home uplink; narrower wastes it. */
const PUTS = 4;
/** Batches queued or running before the renderer is made to wait. Bounds memory. */
const MAX_PENDING_BATCHES = 2;

export function useSlideUpload(
  sessionId: string,
  handlers: SlideUploadHandlers = {},
): SlideUploadState {
  const [busy, setBusy] = useState(0);
  const [converting, setConverting] = useState<{ page: number; pages: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const addedRef = useRef(false);
  // Kept in refs so `upload` is not rebuilt — and cannot go stale — every time
  // the caller re-renders.
  const onDoneRef = useRef(handlers.onDone);
  onDoneRef.current = handlers.onDone;
  const onAddedRef = useRef(handlers.onAdded);
  onAddedRef.current = handlers.onAdded;

  const upload = useCallback(
    async (input: FileList | File[]) => {
      setError(null);
      setDetail(null);
      addedRef.current = false;
      const chosen = Array.from(input);
      /** A batch of pages at a time, in order, across every file of this drop. */
      let added = 0;

      const queue: File[] = [];
      let chain: Promise<void> = Promise.resolve();
      let pendingBatches = 0;

      /**
       * Sign, upload and confirm one batch.
       *
       * The slots array is what keeps the deck in page order: the PUTs finish
       * in whatever order the network gives, and the confirm must not reorder
       * the pages because of it.
       */
      const processBatchOnce = async (batch: File[]) => {
        const tickets = await requestSlideUploads({
          sessionId,
          pages: batch.map((file) => ({ contentType: file.type, byteSize: file.size })),
        });
        if (!tickets.ok || !tickets.tickets || tickets.tickets.length === 0) {
          setError(tickets.error ?? 'uploadFailed');
          return;
        }
        if (tickets.skipped) setError('deckFull');

        const accepted = batch.slice(0, tickets.tickets.length);
        const slots: ({ key: string; filename: string } | null)[] = accepted.map(() => null);

        await runPool(accepted, PUTS, async (file, index) => {
          const ticket = tickets.tickets?.[index];
          if (!ticket) return;
          try {
            const put = await fetch(ticket.url, {
              method: 'PUT',
              body: file,
              headers: { 'Content-Type': ticket.contentType },
            });
            if (!put.ok) throw new Error(`HTTP ${put.status}`);
            slots[index] = { key: ticket.key, filename: file.name };
          } catch (thrown) {
            // A rejected fetch — a CORS refusal, a dropped connection — arrives
            // with no status and only the browser's own words. This is an
            // UPLOAD failure; without this catch it escaped to the PDF branch,
            // which relabelled it "conversion failed" and sent the office to
            // the wrong problem. The origin is included because a bucket's CORS
            // rule is written against exactly that string.
            setError('uploadFailed');
            setDetail(
              `${
                thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
              } (origin ${window.location.origin})`,
            );
          }
        });

        const uploads = slots.filter(
          (slot): slot is { key: string; filename: string } => slot !== null,
        );
        if (uploads.length === 0) return;

        const done = await confirmSlides({ sessionId, uploads });
        if (!done.ok || !done.slides) {
          setError(done.error ?? 'uploadFailed');
          if (done.detail) setDetail(done.detail);
          return;
        }
        for (const slide of done.slides) onAddedRef.current?.(slide, added++);

        const refused = done.failed?.[0];
        if (refused) {
          setError(refused.error);
          if (refused.detail) setDetail(refused.detail);
        }
      };

      /**
       * Never let a batch reject the chain.
       *
       * A server action that cannot be reached at all — offline, a redeploy —
       * throws rather than returning `{ ok: false }`. Left uncaught that skips
       * every batch behind it in the chain and rejects a promise nobody awaits,
       * which is a console warning instead of the sentence the teacher needs.
       */
      const processBatch = async (batch: File[]) => {
        try {
          await processBatchOnce(batch);
        } catch (thrown) {
          setError('uploadFailed');
          setDetail(
            thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
          );
        }
      };

      /**
       * Hand a page over for upload, and let the render loop run ahead of it —
       * up to a point. Returning the chain when the queue is deep is what
       * applies backpressure: the engine waits for a batch to land rather than
       * turning a hundred pages into a hundred megabytes of canvas.
       */
      const enqueue = (file: File): Promise<void> | void => {
        if (file.size > MAX_IMAGE_BYTES) {
          setError('tooLarge');
          return;
        }
        queue.push(file);
        if (queue.length >= BATCH) {
          const batch = queue.splice(0, BATCH);
          pendingBatches += 1;
          chain = chain
            .then(() => processBatch(batch))
            .finally(() => {
              pendingBatches -= 1;
            });
          if (pendingBatches >= MAX_PENDING_BATCHES) return chain;
        }
      };

      const flush = () => {
        if (queue.length > 0) {
          const batch = queue.splice(0, queue.length);
          chain = chain.then(() => processBatch(batch));
        }
        return chain;
      };

      for (const file of chosen) {
        const kind = classifyUpload(file);

        if (kind === 'office') {
          // Named rather than lumped in with "unsupported": rendering a .pptx
          // faithfully needs LibreOffice on a server, which this platform
          // deliberately does not have, and PowerPoint exports to PDF in two
          // clicks. Saying which two is worth more than a refusal.
          setError('convertToPdf');
          continue;
        }
        if (kind === 'unsupported') {
          setError('notAnImage');
          continue;
        }

        setBusy((n) => n + 1);
        try {
          if (kind === 'pdf') {
            const { pdfPages } = await import('@/lib/media/pdf');
            const delivered = await pdfPages(file, {
              onProgress: (progress) => setConverting(progress),
              onPage: (page) => enqueue(page.file),
            });
            setConverting(null);
            if (delivered === 0) setError('pdfEmpty');
          } else {
            enqueue(file);
          }
        } catch (thrown) {
          setConverting(null);
          if (thrown instanceof PdfError) {
            // Three different problems with three different things to do about
            // them; saying "could not be read" for all three helps nobody.
            setError(
              thrown.reason === 'password'
                ? 'pdfPassword'
                : thrown.reason === 'corrupt'
                  ? 'pdfCorrupt'
                  : thrown.reason === 'empty'
                    ? 'pdfEmpty'
                    : 'pdfEngine',
            );
            setDetail(thrown.detail);
          } else {
            setError(kind === 'pdf' ? 'pdfEngine' : 'uploadFailed');
            setDetail(
              thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
            );
          }
        } finally {
          setBusy((n) => n - 1);
        }
      }

      // Whatever is left in the queue, then every batch that is still running.
      await flush();
      if (addedRef.current) onDoneRef.current?.();
    },
    [sessionId],
  );

  return {
    busy,
    converting,
    error,
    detail,
    clearError: () => {
      setError(null);
      setDetail(null);
    },
    upload,
  };
}
