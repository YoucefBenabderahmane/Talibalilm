'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Film, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActionError } from '@/components/admin/ActionError';
import {
  formatBytes,
  MAX_VIDEO_BYTES,
  partCount,
  sniffVideo,
  VIDEO_ACCEPT,
} from '@/lib/media/video';
import { PartUploadError, uploadParts } from '@/lib/media/part-upload';
import {
  abortLessonVideoUpload,
  finishLessonVideoUpload,
  lessonVideoUploadedParts,
  removeLessonVideo,
  setVideoRetention,
  signLessonVideoParts,
  startLessonVideoUpload,
} from '@/app/actions/video';
import type { AdminState } from '@/app/actions/admin';

const IDLE: AdminState = { ok: false };

/** An upload begun on this machine, kept so a reload can resume it. */
interface Pending {
  key: string;
  uploadId: string;
  partSize: number;
  name: string;
  size: number;
  lastModified: number;
}

const pendingKey = (lessonId: string, classId: string) =>
  `talibalim-video-upload:${lessonId}:${classId}`;

function readPending(lessonId: string, classId: string): Pending | null {
  try {
    const raw = window.localStorage.getItem(pendingKey(lessonId, classId));
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

function writePending(lessonId: string, classId: string, pending: Pending | null) {
  try {
    if (pending) window.localStorage.setItem(pendingKey(lessonId, classId), JSON.stringify(pending));
    else window.localStorage.removeItem(pendingKey(lessonId, classId));
  } catch {
    /* Only the resume after a reload is lost. */
  }
}

/**
 * Can this browser play the file? Asked of a hidden `<video>` before anything
 * is sent: an iPhone's HEVC .mov, for one, is a valid file most PCs cannot
 * show. Undecided after a few seconds counts as yes — this warns, it never
 * blocks on its own.
 */
function playableHere(file: File): Promise<boolean> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    const timer = window.setTimeout(() => done(true), 8000);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => done(video.videoWidth > 0);
    video.onerror = () => done(false);
    video.src = url;
  });
}

/**
 * Upload a lesson video straight to R2, in parts.
 *
 * The file never touches our server. A Server Action body is capped at a few
 * megabytes and a Vercel function would be paying for bandwidth to forward
 * bytes it has no interest in — so the browser PUTs to Cloudflare against
 * signatures, and the server afterwards reads the first bytes back to decide
 * whether what arrived is really a video.
 *
 * In parts (`uploadParts`), because one PUT of a long recording was lost whole
 * to a single dropped connection and reported only as « refused or
 * interrupted ». A drop now costs one part; offline, the upload waits and goes
 * on by itself; and the same file chosen again after a reload or a failure
 * resumes where it stopped, from the parts R2 already holds.
 */
export function LessonVideoUpload({
  lessonId,
  classId,
  provider,
  bytes,
  expiresAt,
}: {
  lessonId: string;
  /** The group this recording belongs to. A lesson's video is per class. */
  classId: string;
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

  /** Cancels the upload in progress. */
  const cancelRef = useRef<AbortController | null>(null);
  /** Waiting for the connection, or for a retry. */
  const [waiting, setWaiting] = useState(false);
  /** Part of the file was already in R2 from an earlier try. */
  const [resumed, setResumed] = useState(false);

  // Closing the tab mid-upload asks first. (It would resume, but only once the
  // same file is chosen again.)
  useEffect(() => {
    if (percent === null) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [percent]);

  const send = useCallback(
    async (file: File) => {
      setState(IDLE);
      setResumed(false);

      // Refused here rather than after an hour of uploading. The server
      // checks the MEASURED size afterwards regardless — this is a courtesy,
      // not the rule.
      if (file.size > MAX_VIDEO_BYTES) {
        setState({ ok: false, error: 'videoTooLarge' });
        return;
      }

      // The container, from the file's own first bytes, before anything is
      // sent: an .avi is refused now, not after the upload. The server reads
      // the same bytes back afterwards and decides for itself.
      const kind = sniffVideo(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
      if (!kind) {
        setState({ ok: false, error: 'notAVideo' });
        return;
      }
      if (!(await playableHere(file)) && !window.confirm(t('videoUnplayableConfirm'))) return;
      const contentType = kind === 'webm' ? 'video/webm' : 'video/mp4';

      // The same file, begun before a reload or a failure: carry on from the
      // parts R2 already holds.
      let pending = readPending(lessonId, classId);
      let done: number[] = [];
      if (
        pending &&
        (pending.name !== file.name ||
          pending.size !== file.size ||
          pending.lastModified !== file.lastModified)
      ) {
        pending = null;
      }
      if (pending) {
        const held = await lessonVideoUploadedParts({
          lessonId,
          key: pending.key,
          uploadId: pending.uploadId,
        });
        if (held.ok && held.parts && !held.gone) {
          done = held.parts;
          setResumed(done.length > 0);
        } else {
          pending = null;
        }
      }
      if (!pending) {
        const ticket = await startLessonVideoUpload({
          lessonId,
          classId,
          contentType,
          size: file.size,
        });
        if (!ticket.ok || !ticket.key || !ticket.uploadId || !ticket.partSize) {
          setState(ticket);
          return;
        }
        pending = {
          key: ticket.key,
          uploadId: ticket.uploadId,
          partSize: ticket.partSize,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
        };
        writePending(lessonId, classId, pending);
      }
      const upload = pending;

      const cancel = new AbortController();
      cancelRef.current = cancel;
      setPercent(0);
      try {
        await uploadParts({
          file,
          partSize: upload.partSize,
          done,
          sign: async (parts) => {
            const signed = await signLessonVideoParts({
              lessonId,
              key: upload.key,
              uploadId: upload.uploadId,
              parts,
            });
            if (!signed.ok || !signed.urls) {
              throw new PartUploadError(signed.detail ?? signed.error ?? 'signing failed', 0);
            }
            return signed.urls;
          },
          onProgress: (sent, total) => setPercent(Math.floor((sent / total) * 100)),
          onWaiting: setWaiting,
          signal: cancel.signal,
        });
      } catch (cause) {
        setPercent(null);
        setWaiting(false);
        cancelRef.current = null;
        if (cancel.signal.aborted) {
          // Cancelled: the parts already sent are thrown away, not kept.
          writePending(lessonId, classId, null);
          await abortLessonVideoUpload({ lessonId, key: upload.key, uploadId: upload.uploadId });
          return;
        }
        // Kept: choosing the same file again carries on from here.
        setState({
          ok: false,
          error: 'uploadFailed',
          detail: `${cause instanceof Error ? cause.message : String(cause)} — ${t('videoResumeHint')}`,
        });
        return;
      }

      setPercent(null);
      setWaiting(false);
      cancelRef.current = null;
      const result = await finishLessonVideoUpload({
        lessonId,
        classId,
        key: upload.key,
        uploadId: upload.uploadId,
        parts: partCount(file.size, upload.partSize),
      });
      // Joined (or refused for its content): either way there is nothing left
      // to resume. A missing part keeps the upload for the next try.
      if (result.ok || result.error !== 'uploadFailed') writePending(lessonId, classId, null);
      if (result.ok) setUploaded({ bytes: file.size });
      setState(result);
    },
    [lessonId, classId, t],
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
        accept={VIDEO_ACCEPT}
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
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-[11px] text-ink-muted" role="status">
              {t('videoUploading', { percent })}
              {resumed && ` · ${t('videoResumed')}`}
            </p>
            {waiting && (
              <p className="text-[11px] text-gold-700" role="status">
                {t('videoWaiting')}
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                if (window.confirm(t('videoCancelConfirm'))) cancelRef.current?.abort();
              }}
              className="ms-auto inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-red-600"
            >
              <X className="size-3" aria-hidden="true" />
              {t('videoCancel')}
            </button>
          </div>
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
                  const result = await removeLessonVideo({ lessonId, classId });
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
                        classId,
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
