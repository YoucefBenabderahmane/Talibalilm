'use client';

import { useActionState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, ImageOff, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { deleteAllSlides, deleteSlide, moveSlide } from '@/app/actions/slides';
import { ActionError } from '@/components/admin/ActionError';
import { useSlideUpload } from '@/components/live/useSlideUpload';
import type { AdminState } from '@/app/actions/admin';
import type { SlideView } from '@/lib/data/live';

const EMPTY: AdminState = { ok: true };
const IDLE: AdminState = { ok: false };

/**
 * The deck for one class.
 *
 * The file never passes through the application server. The browser asks for a
 * ticket, uploads straight to Cloudflare with it, then tells the server the
 * upload is done — at which point the server reads the first bytes back and
 * decides whether what arrived is really an image. So the size of a slide costs
 * the school nothing in function time, and a renamed `.exe` still never becomes
 * a slide.
 *
 * Progress is per file and the list refreshes as each one lands, because a
 * teacher uploading twenty slides before a class needs to see it happening.
 */
export function SlideDeck({
  sessionId,
  slides,
  storageReady,
  missing = [],
}: {
  sessionId: string;
  slides: SlideView[];
  storageReady: boolean;
  /** Which R2 variables the server cannot see. Names only, never values. */
  missing?: string[];
}) {
  const t = useTranslations('admin');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();
  const { busy, converting, error, detail, upload } = useSlideUpload(sessionId, {
    onDone: () => router.refresh(),
  });

  const [, remove] = useActionState(deleteSlide, EMPTY);
  const [, move] = useActionState(moveSlide, EMPTY);
  const [clearState, clear] = useActionState(deleteAllSlides, IDLE);

  const choose = (files: FileList | File[]) => {
    void upload(files).then(() => {
      if (inputRef.current) inputRef.current.value = '';
    });
  };

  if (!storageReady) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-line bg-surface/50 p-6">
        <p className="text-[13px] text-ink-muted">{t('slidesStorageMissing')}</p>
        {missing.length > 0 && (
          <ul className="mt-3 space-y-1 font-mono text-[12px] text-red-600">
            {missing.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-ink-muted">{t('slidesStorageHint')}</p>
      </div>
    );
  }

  return (
    <div>
      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-line bg-surface/40 p-6 text-center transition-colors hover:border-brand-300 hover:bg-brand-50/40">
        <Upload className="size-5 text-ink-muted" aria-hidden="true" />
        <span className="text-[13px] font-medium text-ink">
          {converting
            ? t('slidesConverting', { page: converting.page, pages: converting.pages })
            : busy > 0
              ? t('slidesUploading', { count: busy })
              : t('slidesAdd')}
        </span>
        <span className="text-[11px] text-ink-muted">{t('slidesHint')}</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,application/pdf"
          multiple
          className="sr-only"
          onChange={(event) => {
            if (event.target.files?.length) choose(event.target.files);
          }}
        />
      </label>

      {error && (
        <div role="alert" className="mt-3">
          <p className="text-[12px] leading-relaxed text-red-600">
            {t(`errors.${error}` as 'errors.uploadFailed')}
          </p>
          {detail && (
            <p className="mt-1 font-mono text-[11px] break-words text-ink-muted">{detail}</p>
          )}
        </div>
      )}

      {slides.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
          <ActionError state={clearState} />
          <form
            action={clear}
            onSubmit={(event) => {
              if (!window.confirm(t('slidesClearConfirm', { count: slides.length }))) {
                event.preventDefault();
              }
            }}
          >
            <input type="hidden" name="sessionId" value={sessionId} />
            <button
              type="submit"
              disabled={busy > 0}
              className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-[12px] text-ink-muted transition-colors hover:border-red-300 hover:text-red-600 disabled:opacity-40"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t('slidesClearAll')}
            </button>
          </form>
        </div>
      )}

      {slides.length === 0 ? (
        <p className="mt-4 text-center text-[13px] text-ink-muted">{t('slidesNone')}</p>
      ) : (
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {slides.map((slide, index) => (
            <li
              key={slide.id}
              className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-white"
            >
              <div className="relative aspect-video bg-surface">
                {slide.url ? (
                  // A plain <img>, not next/image, and deliberately. The src is
                  // a signed URL that expires within the hour: putting it
                  // through the optimizer would have Next cache a link that
                  // stops working, and would require the optimizer itself to
                  // hold credentials for a private bucket. Nothing is gained —
                  // the file is already a bounded, teacher-supplied image.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={slide.url}
                    alt={slide.filename || t('slidesNumber', { n: index + 1 })}
                    loading="lazy"
                    className="absolute inset-0 size-full object-contain"
                  />
                ) : (
                  <span className="flex h-full items-center justify-center text-ink-muted">
                    <ImageOff className="size-5" aria-hidden="true" />
                  </span>
                )}
                <span className="absolute start-2 top-2 rounded-full bg-ink/70 px-2 py-0.5 text-[11px] font-medium text-white">
                  {index + 1}
                </span>
              </div>

              <div className="flex items-center gap-1 border-t border-line p-2">
                <p className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
                  {slide.filename || t('slidesNumber', { n: index + 1 })}
                </p>

                <form action={move}>
                  <input type="hidden" name="id" value={slide.id} />
                  <input type="hidden" name="sessionId" value={sessionId} />
                  <input type="hidden" name="direction" value="up" />
                  <button
                    type="submit"
                    disabled={index === 0 || busy > 0}
                    title={t('slidesMoveUp')}
                    className="rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-brand-50 hover:text-brand-600 disabled:opacity-30"
                  >
                    <ChevronUp className="size-4" aria-hidden="true" />
                    <span className="sr-only">{t('slidesMoveUp')}</span>
                  </button>
                </form>

                <form action={move}>
                  <input type="hidden" name="id" value={slide.id} />
                  <input type="hidden" name="sessionId" value={sessionId} />
                  <input type="hidden" name="direction" value="down" />
                  <button
                    type="submit"
                    disabled={index === slides.length - 1 || busy > 0}
                    title={t('slidesMoveDown')}
                    className="rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-brand-50 hover:text-brand-600 disabled:opacity-30"
                  >
                    <ChevronDown className="size-4" aria-hidden="true" />
                    <span className="sr-only">{t('slidesMoveDown')}</span>
                  </button>
                </form>

                <form
                  action={remove}
                  onSubmit={(event) => {
                    if (!window.confirm(t('slidesDeleteConfirm'))) event.preventDefault();
                  }}
                >
                  <input type="hidden" name="id" value={slide.id} />
                  <input type="hidden" name="sessionId" value={sessionId} />
                  <button
                    type="submit"
                    title={t('slidesDelete')}
                    className="rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    <span className="sr-only">{t('slidesDelete')}</span>
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
