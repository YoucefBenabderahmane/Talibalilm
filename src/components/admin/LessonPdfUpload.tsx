'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActionError } from '@/components/admin/ActionError';
import { thrownAction } from '@/components/admin/thrown-action';
import { formatBytes } from '@/lib/media/video';
import { MAX_DOCUMENT_BYTES } from '@/lib/media/document';
import { PartUploadError, uploadParts, xhrPutWith } from '@/lib/media/part-upload';
import { uploadLane } from '@/lib/media/upload-lane';
import {
  finishLessonDocumentUpload,
  removeLessonDocument,
  startLessonDocumentUpload,
} from '@/app/actions/lesson-file';
import type { AdminState } from '@/app/actions/admin';
import type { LessonDocument } from '@/lib/content/lesson-files';

const IDLE: AdminState = { ok: false };

/** The upload link is signed for this type: the PUT must send it too. */
const putPdf = xhrPutWith({ 'Content-Type': 'application/pdf' });

/** The server refused to hand out an upload link: its answer is shown as it is. */
class TicketRefused extends Error {
  constructor(readonly state: AdminState) {
    super(state.error ?? 'refused');
  }
}

/**
 * Upload a lesson's support documents straight to R2.
 *
 * The file goes through the video's uploader (`uploadParts`), as one part.
 * It used to go in one bare request that gave up for good after two minutes
 * without progress — and on 20 November a PDF sent while the lesson's video
 * was uploading got no bytes through for two minutes and was abandoned, while
 * the video, which retries, carried on. Now the PDF gets the same treatment:
 *
 * - it waits its turn: one file at a time on the page (`lib/media/upload-lane.ts`);
 * - a try that stops moving for a minute is cut and sent again, with a growing
 *   pause, up to eight tries;
 * - offline time is waited out, not counted, and said on screen;
 * - a refused or expired link is replaced by a fresh one;
 * - it can be cancelled, and closing the tab mid-way asks first.
 *
 * Several documents are allowed. The list shown is the server's, plus anything
 * uploaded or removed in this session, so the entry never disappears between
 * the upload finishing and the page re-rendering.
 */
export function LessonPdfUpload({
  lessonId,
  classId,
  documents,
}: {
  lessonId: string;
  /** The group this support belongs to. A lesson's documents are per class. */
  classId: string;
  documents: LessonDocument[];
}) {
  const t = useTranslations('admin');
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<AdminState>(IDLE);
  const [percent, setPercent] = useState<number | null>(null);
  /** Another upload on the page goes first; this one starts right after. */
  const [queued, setQueued] = useState(false);
  /** Offline, or pausing before another try. */
  const [waiting, setWaiting] = useState(false);
  const cancelRef = useRef<AbortController | null>(null);
  /** Uploaded or removed in this session, before the server re-render lands. */
  const [added, setAdded] = useState<LessonDocument[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);

  const shown = [...documents, ...added]
    .filter((document, index, all) => all.findIndex((d) => d.key === document.key) === index)
    .filter((document) => !removed.includes(document.key));

  // Closing the tab while the file is sent, or waits its turn, asks first.
  useEffect(() => {
    if (percent === null && !queued) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [percent, queued]);

  const send = useCallback(
    async (file: File) => {
      setState(IDLE);

      // Refused here rather than after an hour of uploading. The server checks
      // the MEASURED size afterwards regardless — this is a courtesy.
      if (file.size > MAX_DOCUMENT_BYTES) {
        setState({ ok: false, error: 'documentTooLarge' });
        return;
      }

      const cancel = new AbortController();
      cancelRef.current = cancel;
      let release: () => void;
      try {
        release = await uploadLane.take(cancel.signal, setQueued);
      } catch {
        // « Annuler » while waiting its turn: nothing was sent.
        cancelRef.current = null;
        return;
      }

      try {
        // Each link names its own key: a link replaced mid-way (expired,
        // refused) means the file lands under the newest one.
        let key: string | null = null;
        setPercent(0);
        try {
          await uploadParts({
            file,
            partSize: Math.max(1, file.size),
            concurrency: 1,
            sign: async () => {
              const ticket = await startLessonDocumentUpload({
                lessonId,
                classId,
                contentType: 'application/pdf',
                size: file.size,
              });
              if (!ticket.ok || !ticket.url || !ticket.key) throw new TicketRefused(ticket);
              key = ticket.key;
              return { 1: ticket.url };
            },
            put: putPdf,
            onProgress: (sent, total) => setPercent(Math.floor((sent / total) * 100)),
            onWaiting: setWaiting,
            signal: cancel.signal,
          });
        } catch (cause) {
          // Cancelled: nothing to keep. A file R2 already holds has no row, so
          // no page can reach it.
          if (cancel.signal.aborted) return;
          if (cause instanceof TicketRefused) setState(cause.state);
          else if (cause instanceof PartUploadError) {
            setState({
              ok: false,
              error: 'uploadFailed',
              // No answer at all is a dropped connection or a CORS refusal, and
              // the browser does not say which: name the test that tells them apart.
              detail:
                cause.status === 0
                  ? `${cause.message} — if it happens again, run Admin → Diagnostic → « Tester l’envoi depuis le navigateur », which reproduces this exact request and names the missing rule`
                  : cause.message,
            });
          } else setState(thrownAction(cause));
          return;
        } finally {
          setPercent(null);
          setWaiting(false);
        }

        const stored = key as string | null;
        if (!stored) return;
        const result = await finishLessonDocumentUpload({
          lessonId,
          classId,
          key: stored,
          filename: file.name,
        });
        if (result.ok) {
          setAdded((list) => [
            ...list,
            {
              key: stored,
              filename: file.name,
              bytes: file.size,
              uploadedAt: new Date().toISOString(),
            },
          ]);
        }
        setState(result);
      } catch (error) {
        // A server action that threw — a page older than the site, usually.
        setState(thrownAction(error));
      } finally {
        release();
        cancelRef.current = null;
        setQueued(false);
      }
    },
    [lessonId, classId],
  );

  return (
    <div className="rounded-[var(--radius-input)] border border-line bg-surface/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="size-4 text-ink-muted" aria-hidden="true" />
        <p className="text-[13px] font-medium text-ink">{t('pdfUpload')}</p>
      </div>

      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{t('pdfUploadHint')}</p>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void send(file);
        }}
      />

      {percent !== null || queued ? (
        <div className="mt-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-line">
            <div
              className="h-full bg-brand-500 transition-[width]"
              style={{ width: `${percent ?? 0}%` }}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-[11px] text-ink-muted" role="status">
              {queued ? t('uploadQueued') : t('pdfUploading', { percent: percent ?? 0 })}
            </p>
            {waiting && (
              <p className="text-[11px] text-gold-700" role="status">
                {t('videoWaiting')}
              </p>
            )}
            <button
              type="button"
              onClick={() => cancelRef.current?.abort()}
              className="ms-auto inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-red-600"
            >
              <X className="size-3" aria-hidden="true" />
              {t('videoCancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="size-3.5" aria-hidden="true" />
            {shown.length > 0 ? t('pdfAdd') : t('pdfChoose')}
          </Button>
        </div>
      )}

      {shown.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {shown.map((document) => (
            <li
              key={document.key}
              className="flex items-center gap-2 rounded-[var(--radius-input)] border border-line bg-white px-3 py-2"
            >
              <FileText className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                {document.filename}
              </span>
              <span className="shrink-0 text-[11px] text-ink-muted">
                {formatBytes(document.bytes)}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-red-600 hover:text-red-700"
                onClick={async () => {
                  if (!window.confirm(t('pdfRemoveConfirm'))) return;
                  const result = await removeLessonDocument({
                    lessonId,
                    classId,
                    key: document.key,
                  });
                  if (result.ok) setRemoved((list) => [...list, document.key]);
                  setState(result);
                }}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                <span className="sr-only">{t('pdfRemove')}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ActionError state={state} />
      {state.ok && !state.error && (
        <p role="status" className="mt-2 text-[11px] text-brand-600">
          {t('saved')}
        </p>
      )}
    </div>
  );
}
