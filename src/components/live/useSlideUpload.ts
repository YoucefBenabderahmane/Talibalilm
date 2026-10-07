'use client';

import { useCallback, useRef, useState } from 'react';
import {
  attachDeck,
  confirmSlides,
  lookupDeck,
  registerDeck,
  requestSlideUploads,
  type CatalogPage,
} from '@/app/actions/slides';
import { MAX_IMAGE_BYTES } from '@/lib/media/image';
import { isDeckKey } from '@/lib/storage/key';
import { abortAfter, withDeadline } from '@/lib/media/deadline';
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
  /** Pages the deck had no room for — the cap, made visible rather than silent. */
  skipped: number;
  /**
   * A fact about how the conversion ran, when it is worth saying.
   *
   * Today that is one thing: the worker pool was not available and the deck is
   * being drawn on the room's own thread. Staff see it; nobody should have to
   * guess which path ran.
   */
  notice: string | null;
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
  /**
   * Read once per file, when the conversion starts. True while the room is
   * recording or presenting, so the pool keeps two workers instead of four and
   * the recording keeps its frames.
   */
  lowPriority?: () => boolean;
}

/**
 * Pages signed and confirmed in one round trip.
 *
 * Ten, so a large deck reaches the class in tens: the first ten pages appear
 * while the next ten are still being drawn, rather than the whole file landing
 * at the end.
 */
const BATCH = 10;
/** PUTs in flight at once. Wider saturates a home uplink; narrower wastes it. */
const PUTS = 4;
/** Batches queued or running before the renderer is made to wait. Bounds memory. */
const MAX_PENDING_BATCHES = 2;

/**
 * A Server Action that has not answered within this long is abandoned.
 *
 * The action may still finish on the server; the upload simply stops holding
 * the lesson open for it and says which call failed. Without this, a request
 * the platform never completes left "Envoi…" on screen forever — the stall the
 * teacher reported, with no error and nothing to act on.
 */
const ACTION_DEADLINE_MS = 30_000;

/**
 * One page PUT. Generous enough for a 5 MB page on a slow line, short enough
 * that a connection accepted and then never answered is cut off instead of
 * hanging the batch — and with it the whole deck — forever.
 */
const PUT_DEADLINE_MS = 180_000;

export function useSlideUpload(
  sessionId: string,
  handlers: SlideUploadHandlers = {},
): SlideUploadState {
  const [busy, setBusy] = useState(0);
  const [converting, setConverting] = useState<{ page: number; pages: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const addedRef = useRef(false);
  // Kept in refs so `upload` is not rebuilt — and cannot go stale — every time
  // the caller re-renders.
  const onDoneRef = useRef(handlers.onDone);
  onDoneRef.current = handlers.onDone;
  const onAddedRef = useRef(handlers.onAdded);
  onAddedRef.current = handlers.onAdded;
  const lowPriorityRef = useRef(handlers.lowPriority);
  lowPriorityRef.current = handlers.lowPriority;

  const upload = useCallback(
    async (input: FileList | File[]) => {
      setError(null);
      setDetail(null);
      setSkipped(0);
      setNotice(null);
      addedRef.current = false;
      const chosen = Array.from(input);
      /** A batch of pages at a time, in order, across every file of this drop. */
      let added = 0;
      let skippedPages = 0;

      type QueuedPage = { file: File; fingerprint?: string };

      const queue: QueuedPage[] = [];
      let chain: Promise<void> = Promise.resolve();
      let pendingBatches = 0;
      /**
       * A freshly rendered PDF's pages, in order, as they land — what the
       * catalogue is written from once the whole deck is up. Keyed by the
       * PDF's fingerprint so two PDFs in one drop cannot mix.
       */
      const catalogPages = new Map<string, CatalogPage[]>();

      /**
       * Sign, upload and confirm one batch.
       *
       * The slots array is what keeps the deck in page order: the PUTs finish
       * in whatever order the network gives, and the confirm must not reorder
       * the pages because of it.
       */
      const processBatchOnce = async (batch: QueuedPage[]) => {
        const tickets = await withDeadline(
          requestSlideUploads({
            sessionId,
            pages: batch.map(({ file, fingerprint }) => ({
              contentType: file.type,
              byteSize: file.size,
              fingerprint,
            })),
          }),
          ACTION_DEADLINE_MS,
          'requesting upload tickets',
        );
        if (!tickets.ok || !tickets.tickets || tickets.tickets.length === 0) {
          setError(tickets.error ?? 'uploadFailed');
          return;
        }
        if (tickets.skipped) {
          skippedPages += tickets.skipped;
          setSkipped(skippedPages);
          setError('deckFull');
        }

        const accepted = batch.slice(0, tickets.tickets.length);
        const slots: ({ key: string; filename: string; fingerprint?: string } | null)[] =
          accepted.map(() => null);

        await runPool(accepted, PUTS, async ({ file }, index) => {
          const ticket = tickets.tickets?.[index];
          if (!ticket) return;

          const put = () =>
            fetch(ticket.url, {
              method: 'PUT',
              body: file,
              headers: { 'Content-Type': ticket.contentType },
              signal: abortAfter(PUT_DEADLINE_MS),
            }).then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
            });

          try {
            try {
              await put();
            } catch {
              // One retry: a dropped connection is the common case, and the
              // signature is still valid. A second failure is reported.
              await put();
            }
            slots[index] = {
              key: ticket.key,
              filename: file.name,
              fingerprint: accepted[index]?.fingerprint,
            };
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

        // The catalogue is written from the pages that actually landed, in
        // page order; a failed PUT leaves no entry, which is what stops an
        // incomplete deck from being registered for other classes to attach.
        for (let i = 0; i < slots.length; i += 1) {
          const slot = slots[i];
          const file = accepted[i]?.file;
          if (slot?.fingerprint && file && isDeckKey(slot.key)) {
            catalogPages.get(slot.fingerprint)?.push({
              key: slot.key,
              filename: slot.filename,
              mimeType: file.type,
              byteSize: file.size,
            });
          }
        }

        const uploads = slots.filter(
          (slot): slot is { key: string; filename: string } => slot !== null,
        );
        if (uploads.length === 0) return;

        const done = await withDeadline(
          confirmSlides({ sessionId, uploads }),
          ACTION_DEADLINE_MS,
          'confirming slides',
        );
        if (!done.ok || !done.slides) {
          setError(done.error ?? 'uploadFailed');
          if (done.detail) setDetail(done.detail);
          return;
        }
        for (const slide of done.slides) {
          addedRef.current = true;
          onAddedRef.current?.(slide, added++);
        }

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
      const processBatch = async (batch: QueuedPage[]) => {
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
      const enqueue = (file: File, fingerprint?: string): Promise<void> | void => {
        if (file.size > MAX_IMAGE_BYTES) {
          setError('tooLarge');
          return;
        }
        queue.push({ file, fingerprint });
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
            const fingerprint = await sha256Hex(file);

            // The same PDF taught to another class: attach the pages that
            // already exist. No rendering, no upload — the whole reason a
            // 400-page deck can appear in a second on the second class.
            const { known, supported } = await lookupDeck(fingerprint);
            if (known) {
              const attached = await attachDeck({ sessionId, fingerprint });
              if (attached.ok && attached.slides) {
                for (const slide of attached.slides) {
                  addedRef.current = true;
                  onAddedRef.current?.(slide, added++);
                }
              } else {
                setError(attached.error ?? 'uploadFailed');
                if (attached.detail) setDetail(attached.detail);
              }
              continue;
            }

            // The migration may not be applied yet: without the catalogue,
            // pages use the old session-scoped keys and everything still works.
            if (supported) catalogPages.set(fingerprint, []);
            let totalPages = 0;
            let shownProgress = 0;
            const delivered = await pdfPages(file, {
              lowPriority: lowPriorityRef.current?.() ?? false,
              // A silent fallback is how a week went by without anyone knowing
              // which path ran. Staff see this line; the console keeps the raw
              // reason.
              onFallback: (reason) => {
                setNotice(
                  `Conversion PDF sans fils dédiés (${reason}) : elle se fait sur l’onglet, qui peut répondre lentement pendant ce temps.`,
                );
              },
              onProgress: (progress) => {
                totalPages = progress.pages;
                // Every page would re-render the whole room for a number
                // nobody reads that closely; it moves in fives, and always at
                // the first and the last.
                if (
                  progress.page === 1 ||
                  progress.page === progress.pages ||
                  progress.page - shownProgress >= 5
                ) {
                  shownProgress = progress.page;
                  setConverting(progress);
                }
              },
              onPage: (page) => enqueue(page.file, supported ? fingerprint : undefined),
            });
            setConverting(null);
            if (delivered === 0) setError('pdfEmpty');

            // The whole deck must be up before it is catalogued: a catalogue
            // entry is a promise to every future class that these pages exist.
            await flush();
            const pages = catalogPages.get(fingerprint) ?? [];
            if (
              supported &&
              totalPages > 0 &&
              delivered === totalPages &&
              pages.length === totalPages
            ) {
              await registerDeck({ fingerprint, pages });
            }
            catalogPages.delete(fingerprint);
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
    skipped,
    notice,
    clearError: () => {
      setError(null);
      setDetail(null);
    },
    upload,
  };
}

/**
 * The PDF's own name, as bytes: SHA-256 of the file.
 *
 * The catalogue is keyed by this, so the same document is recognised whatever
 * it is called — teachers rename exports, and a filename is not an identity.
 */
async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
