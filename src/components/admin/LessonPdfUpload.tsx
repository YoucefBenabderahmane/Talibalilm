'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActionError } from '@/components/admin/ActionError';
import { formatBytes } from '@/lib/media/video';
import { MAX_DOCUMENT_BYTES } from '@/lib/media/document';
import {
  finishLessonDocumentUpload,
  removeLessonDocument,
  startLessonDocumentUpload,
} from '@/app/actions/lesson-file';
import type { AdminState } from '@/app/actions/admin';
import type { LessonDocument } from '@/lib/content/lesson-files';

const IDLE: AdminState = { ok: false };
/** No data moved for this long: the connection is dead, not slow. */
const STALL_DEADLINE_MS = 120_000;

/**
 * Upload a lesson's support documents straight to R2.
 *
 * `XMLHttpRequest`, not `fetch`, and for the same reason as the video uploader:
 * fetch has no upload-progress event, and a one-gigabyte file with no visible
 * progress is indistinguishable from a hang.
 *
 * The stall deadline is measured BETWEEN progress events, not from the start.
 * A large file on a home uplink is allowed to take an hour; it is not allowed
 * to stop moving. That is the failure the teacher was hitting — a connection
 * that accepted the byte stream and then went quiet.
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
  /** Uploaded or removed in this session, before the server re-render lands. */
  const [added, setAdded] = useState<LessonDocument[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);

  const shown = [...documents, ...added]
    .filter((document, index, all) => all.findIndex((d) => d.key === document.key) === index)
    .filter((document) => !removed.includes(document.key));

  const send = useCallback(
    async (file: File) => {
      setState(IDLE);

      // Refused here rather than after an hour of uploading. The server checks
      // the MEASURED size afterwards regardless — this is a courtesy.
      if (file.size > MAX_DOCUMENT_BYTES) {
        setState({ ok: false, error: 'documentTooLarge' });
        return;
      }

      const ticket = await startLessonDocumentUpload({
        lessonId,
        classId,
        contentType: 'application/pdf',
        size: file.size,
      });
      if (!ticket.ok || !ticket.url || !ticket.key) {
        setState(ticket);
        return;
      }

      setPercent(0);
      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          let idle: ReturnType<typeof setTimeout> | null = null;
          const arm = () => {
            if (idle) clearTimeout(idle);
            idle = setTimeout(() => xhr.abort(), STALL_DEADLINE_MS);
          };

          xhr.open('PUT', ticket.url!);
          xhr.setRequestHeader('Content-Type', 'application/pdf');
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) setPercent(Math.round((event.loaded / event.total) * 100));
            arm();
          };
          xhr.onload = () => {
            if (idle) clearTimeout(idle);
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`R2 answered ${xhr.status}`));
          };
          // A CORS refusal and a dropped connection both land here with no
          // detail — the browser does not tell us which. The message says so,
          // and names the one test that can tell them apart.
          xhr.onerror = () => {
            if (idle) clearTimeout(idle);
            reject(
              new Error(
                'the upload was refused or interrupted — run Admin → Diagnostic → ' +
                  '« Tester l’envoi depuis le navigateur », which reproduces this ' +
                  'exact request and names the missing rule',
              ),
            );
          };
          xhr.onabort = () => {
            if (idle) clearTimeout(idle);
            reject(
              new Error('the upload stalled: no data moved for two minutes, so it was abandoned'),
            );
          };

          arm();
          xhr.send(file);
        });
      } catch (cause) {
        setPercent(null);
        setState({
          ok: false,
          error: 'uploadFailed',
          detail: cause instanceof Error ? cause.message : String(cause),
        });
        return;
      }

      setPercent(null);
      const result = await finishLessonDocumentUpload({
        lessonId,
        classId,
        key: ticket.key,
        filename: file.name,
      });
      if (result.ok) {
        setAdded((list) => [
          ...list,
          {
            key: ticket.key!,
            filename: file.name,
            bytes: file.size,
            uploadedAt: new Date().toISOString(),
          },
        ]);
      }
      setState(result);
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

      {percent !== null ? (
        <div className="mt-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-line">
            <div
              className="h-full bg-brand-500 transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-ink-muted" role="status">
            {t('pdfUploading', { percent })}
          </p>
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
