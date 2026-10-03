'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Film, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActionError } from '@/components/admin/ActionError';
import { formatBytes, MAX_VIDEO_BYTES } from '@/lib/media/video';
import {
  finishLessonVideoUpload,
  removeLessonVideo,
  setVideoRetention,
  startLessonVideoUpload,
} from '@/app/actions/video';
import type { AdminState } from '@/app/actions/admin';

const IDLE: AdminState = { ok: false };

/**
 * Upload a lesson video straight to R2.
 *
 * `XMLHttpRequest`, not `fetch`, and that is the whole reason this is not three
 * lines: fetch has no upload-progress event, and a two-gigabyte upload with no
 * visible progress is indistinguishable from a hang. A teacher watching a
 * motionless button for twenty minutes will close the tab, which is the one
 * outcome that wastes the whole upload.
 *
 * The file never touches our server. A Server Action body is capped at a few
 * megabytes and a Vercel function would be paying for bandwidth to forward
 * bytes it has no interest in — so the browser PUTs to Cloudflare against a
 * signature, and the server afterwards reads the first bytes back to decide
 * whether what arrived is really a video.
 */
export function LessonVideoUpload({
  lessonId,
  provider,
  bytes,
  expiresAt,
}: {
  lessonId: string;
  provider: string;
  bytes: number;
  /** ISO date, or null for "keep indefinitely". */
  expiresAt: string | null;
}) {
  const t = useTranslations('admin');
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<AdminState>(IDLE);
  const [percent, setPercent] = useState<number | null>(null);
  /**
   * The upload's own result. The props come from the server render, and until
   * the route re-renders after `finish` they still say "no video" — which
   * reads as "the upload vanished". This makes the size and the Remove button
   * appear the moment R2 accepted the file.
   */
  const [uploaded, setUploaded] = useState<{ bytes: number } | null>(null);
  const hasVideo = (provider === 'r2' && bytes > 0) || uploaded !== null;
  const shownBytes = uploaded?.bytes ?? bytes;

  const send = useCallback(
    async (file: File) => {
      setState(IDLE);

      // Refused here rather than after twenty minutes of uploading. The server
      // checks the MEASURED size afterwards regardless — this is a courtesy,
      // not the rule.
      if (file.size > MAX_VIDEO_BYTES) {
        setState({ ok: false, error: 'videoTooLarge' });
        return;
      }
      const contentType = file.type === 'video/webm' ? 'video/webm' : 'video/mp4';

      const ticket = await startLessonVideoUpload({ lessonId, contentType, size: file.size });
      if (!ticket.ok || !ticket.url || !ticket.key) {
        setState(ticket);
        return;
      }

      setPercent(0);
      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', ticket.url!);
          xhr.setRequestHeader('Content-Type', contentType);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setPercent(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onload = () =>
            xhr.status >= 200 && xhr.status < 300
              ? resolve()
              : reject(new Error(`R2 answered ${xhr.status}`));
          // A CORS refusal and a dropped connection both land here with no
          // detail — the browser does not tell us which. The message says so,
          // and names the one test that can tell them apart, rather than
          // guessing at one of the two.
          xhr.onerror = () =>
            reject(
              new Error(
                'the upload was refused or interrupted — run Admin → Diagnostic → ' +
                  '« Tester l’envoi depuis le navigateur », which reproduces this ' +
                  'exact request and names the missing rule',
              ),
            );
          xhr.onabort = () => reject(new Error('the upload was cancelled'));
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
      const result = await finishLessonVideoUpload({ lessonId, key: ticket.key });
      if (result.ok) setUploaded({ bytes: file.size });
      setState(result);
    },
    [lessonId],
  );

  return (
    <div className="rounded-[var(--radius-input)] border border-line bg-surface/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Film className="size-4 text-ink-muted" aria-hidden="true" />
        <p className="text-[13px] font-medium text-ink">{t('videoUpload')}</p>
        {hasVideo && <span className="text-[12px] text-ink-muted">{formatBytes(shownBytes)}</span>}
      </div>

      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{t('videoUploadHint')}</p>

      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/webm"
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
            {t('videoUploading', { percent })}
          </p>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="size-3.5" aria-hidden="true" />
            {hasVideo ? t('videoReplace') : t('videoChoose')}
          </Button>

          {hasVideo && (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-red-600 hover:text-red-700"
                onClick={async () => {
                  if (!window.confirm(t('videoRemoveConfirm'))) return;
                  const result = await removeLessonVideo({ lessonId });
                  if (result.ok) setUploaded(null);
                  setState(result);
                }}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t('videoRemove')}
              </Button>

              {/*
                Retention. R2 bills by the gigabyte-month, so a year of
                recordings left in place is a bill that only grows. Null is
                still the default — the school chooses to forget, we do not
                choose it for them.
              */}
              <label className="ms-auto flex items-center gap-2 text-[11px] text-ink-muted">
                {t('videoKeepFor')}
                <select
                  defaultValue={expiresAt ? 'set' : 'forever'}
                  className="rounded-[var(--radius-input)] border border-line bg-white px-2 py-1 text-[12px] text-ink"
                  onChange={async (event) => {
                    const v = event.currentTarget.value;
                    setState(
                      await setVideoRetention({
                        lessonId,
                        months: v === 'forever' ? null : Number(v),
                      }),
                    );
                  }}
                >
                  <option value="forever">{t('videoKeepForever')}</option>
                  <option value="6">{t('videoKeepMonths', { count: 6 })}</option>
                  <option value="12">{t('videoKeepMonths', { count: 12 })}</option>
                  <option value="24">{t('videoKeepMonths', { count: 24 })}</option>
                  {expiresAt && (
                    <option value="set" disabled>
                      {t('videoKeepSet')}
                    </option>
                  )}
                </select>
              </label>
            </>
          )}
        </div>
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
