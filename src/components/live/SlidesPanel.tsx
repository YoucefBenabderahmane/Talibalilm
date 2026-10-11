'use client';

import { useRef, useState } from 'react';
import { CorsImage } from './CorsImage';
import { useTranslations } from 'next-intl';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  PresentationIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SlideUploadState } from './useSlideUpload';
import type { LiveDeckError } from './useLiveDeck';
import { LiveThumb } from './LiveThumb';

/** The teacher's live deck, as the panel lists it after the uploaded slides. */
export interface LivePanelDeck {
  pages: { id: string; filename: string }[];
  /** A page's thumbnail; drawn only once it scrolls into view. */
  render: (pageId: string) => Promise<ImageBitmap | null>;
  onRemove: (pageId: string) => void;
  /** The file being opened right now, if one is. */
  opening: string | null;
  error: LiveDeckError | null;
  /** The browser would not keep a copy of the file: no restore after a reload. */
  notice: 'notKept' | null;
  /** Why the page could not be sent to the class, verbatim. */
  broadcastError: string | null;
}

type PanelItem =
  | { kind: 'stored'; id: string; url: string | null; filename: string }
  | { kind: 'live'; id: string; filename: string };

/**
 * The deck, during the lesson.
 *
 * The teacher moves; everyone else follows, because the slide index travels as
 * a host-only message and each student's browser refuses one from anywhere
 * else. The images themselves were signed for each viewer by the server after
 * the database confirmed they hold the module, so a student who is not in the
 * class has nothing to render even if they learn the URL.
 *
 * Uploading is owned by the room, not by this panel: a file dropped anywhere
 * on the class lands in the same deck, and this is the button for a teacher
 * who would rather click than drag.
 */
export function SlidesPanel({
  slides,
  current,
  canPresent,
  sharing,
  onGo,
  onRemove,
  onClearAll,
  removeError,
  upload,
  live,
  presentingLive = false,
}: {
  slides: { id: string; url: string | null; filename: string }[];
  current: number;
  canPresent: boolean;
  /** A screen share holds the stage right now. One content at a time. */
  sharing: boolean;
  onGo: (index: number) => void;
  /** The teacher's removal, mid-lesson. Resolves when the server has answered. */
  onRemove: (slideId: string) => Promise<void>;
  /** Empty the whole deck — the teacher's, mid-lesson. */
  onClearAll: () => Promise<void>;
  /** Why the last removal failed, if it did. */
  removeError: { error: string; detail?: string | null } | null;
  /** The room's upload state — one deck, one set of refusals. */
  upload: SlideUploadState;
  /** The pages opened on the teacher's machine. The host's panel only. */
  live?: LivePanelDeck;
  /** A student's panel: the teacher is presenting pages only her machine has. */
  presentingLive?: boolean;
}) {
  const t = useTranslations('live');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const { busy, converting, error, detail, skipped, notice, upload: uploadFiles } = upload;
  const opening = live?.opening ?? null;

  const items: PanelItem[] = [
    ...slides.map((slide) => ({ kind: 'stored' as const, ...slide })),
    ...(live?.pages ?? []).map((page) => ({
      kind: 'live' as const,
      id: page.id,
      filename: page.filename,
    })),
  ];
  const total = items.length;

  const liveErrorText = (failure: LiveDeckError) => {
    switch (failure.code) {
      case 'duplicate':
        return t('errors.liveDuplicate', { name: failure.name });
      case 'busy':
        return t('errors.liveBusy', { name: failure.name });
      case 'pageFailed':
        return t('errors.livePageFailed', { name: failure.name });
      default:
        return t('errors.liveFile', {
          name: failure.name,
          message: t(`errors.${failure.code}` as 'errors.pdfCorrupt'),
        });
    }
  };

  const remove = async (slide: PanelItem) => {
    if (!window.confirm(t('slideRemoveConfirm'))) return;
    if (slide.kind === 'live') {
      // Nothing to wait for: the page lives on this machine.
      live?.onRemove(slide.id);
      return;
    }
    setRemoving(slide.id);
    try {
      await onRemove(slide.id);
    } finally {
      setRemoving(null);
    }
  };

  const clearAll = async () => {
    if (!window.confirm(t('slidesClearConfirm', { count: total }))) return;
    setClearing(true);
    try {
      await onClearAll();
    } finally {
      setClearing(false);
    }
  };

  const choose = (files: FileList | File[]) => {
    void uploadFiles(files).then(() => {
      if (inputRef.current) inputRef.current.value = '';
    });
  };

  const uploader = canPresent ? (
    <label className="m-2 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/20 p-5 text-center transition-colors hover:border-brand-400/70 hover:bg-white/5">
      {busy > 0 || opening ? (
        <Loader2 className="size-5 animate-spin text-white/60" aria-hidden="true" />
      ) : (
        <Upload className="size-5 text-white/50" aria-hidden="true" />
      )}
      <span className="text-[13px] font-medium text-white">
        {opening
          ? t('slidesOpening', { name: opening })
          : converting
          ? t('slidesConverting', { page: converting.page, pages: converting.pages })
          : busy > 0
            ? t('slidesUploading', { count: busy })
            : t('slidesAdd')}
      </span>
      <span className="text-[11px] leading-relaxed text-white/40">{t('slidesHint')}</span>
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
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {uploader}

      {canPresent && sharing && (
        <div className="mx-2 mt-2 rounded-lg border border-gold-500/30 bg-gold-500/10 p-2.5 text-center">
          <p className="text-[11px] leading-relaxed text-gold-200">{t('slidesShareActive')}</p>
        </div>
      )}

      {error && (
        <div role="alert" className="px-3 pb-1.5 text-center">
          <p className="text-[11px] leading-relaxed text-red-300">
            {t(`errors.${error}` as 'errors.uploadFailed')}
          </p>
          {canPresent && detail && (
            <p className="mt-1 font-mono text-[10px] break-words text-white/35">{detail}</p>
          )}
        </div>
      )}

      {live?.error && (
        <div role="alert" className="px-3 pb-1.5 text-center">
          <p className="text-[11px] leading-relaxed text-red-300">{liveErrorText(live.error)}</p>
          {'detail' in live.error && live.error.detail && (
            <p className="mt-1 font-mono text-[10px] break-words text-white/35">
              {live.error.detail}
            </p>
          )}
        </div>
      )}

      {live?.broadcastError && (
        <div role="alert" className="px-3 pb-1.5 text-center">
          <p className="text-[11px] leading-relaxed text-red-300">
            {t('errors.liveBroadcastFailed')}
          </p>
          <p className="mt-1 font-mono text-[10px] break-words text-white/35">
            {live.broadcastError}
          </p>
        </div>
      )}

      {live?.notice && (
        <p
          role="status"
          className="px-3 pb-1.5 text-center text-[11px] leading-relaxed text-gold-200/80"
        >
          {t('slidesLiveNotKept')}
        </p>
      )}

      {!canPresent && presentingLive && total > 0 && (
        <p role="status" className="px-3 pt-2 text-center text-[11px] leading-relaxed text-white/50">
          {t('slidesLiveStudent')}
        </p>
      )}

      {skipped > 0 && (
        <p role="status" className="px-3 pb-1.5 text-center text-[11px] leading-relaxed text-gold-200">
          {t('slidesSkipped', { count: skipped })}
        </p>
      )}

      {/* Which path the conversion ran on, when it was not the fast one. The
          sentence is raw and diagnostic on purpose: an admin screen must show
          the cause, not a guess about it. */}
      {notice && (
        <p
          role="status"
          className="px-3 pb-1.5 text-center text-[11px] leading-relaxed text-gold-200/80"
        >
          {notice}
        </p>
      )}

      {removeError && (
        <div role="alert" className="px-3 pb-1.5 text-center">
          <p className="text-[11px] leading-relaxed text-red-300">
            {t(`errors.${removeError.error}` as 'errors.saveFailed')}
          </p>
          {canPresent && removeError.detail && (
            <p className="mt-1 font-mono text-[10px] break-words text-white/35">
              {removeError.detail}
            </p>
          )}
        </div>
      )}

      {total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <PresentationIcon className="size-5 text-white/30" aria-hidden="true" />
          <p className="text-[12px] text-white/40">
            {canPresent
              ? t('slidesNoneHost')
              : presentingLive
                ? t('slidesLiveStudent')
                : t('slidesNone')}
          </p>
        </div>
      ) : (
        <>
          {canPresent && (
            <div className="flex items-center gap-2 border-b border-white/10 p-2">
              <button
                type="button"
                onClick={() => onGo(Math.max(0, current - 1))}
                disabled={current <= 0}
                className="inline-flex size-8 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 disabled:opacity-30"
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
                <span className="sr-only">{t('slidePrev')}</span>
              </button>
              <p className="flex-1 text-center text-[12px] text-white/60">
                {current + 1} / {total}
              </p>
              <button
                type="button"
                onClick={() => onGo(Math.min(total - 1, current + 1))}
                disabled={current >= total - 1}
                className="inline-flex size-8 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 disabled:opacity-30"
              >
                <ChevronRight className="size-4" aria-hidden="true" />
                <span className="sr-only">{t('slideNext')}</span>
              </button>

              {/* The whole deck at once: a teacher who uploaded the wrong PDF
                  should not have to remove it page by page, mid-lesson. */}
              <button
                type="button"
                onClick={() => void clearAll()}
                disabled={clearing || removing !== null}
                title={t('slidesClearAll')}
                className="inline-flex size-8 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-red-600 hover:text-white disabled:opacity-40"
              >
                {clearing ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 className="size-4" aria-hidden="true" />
                )}
                <span className="sr-only">{t('slidesClearAll')}</span>
              </button>
            </div>
          )}

          <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {items.map((slide, index) => (
              <li key={slide.id} className="relative">
                <button
                  type="button"
                  onClick={() => canPresent && onGo(index)}
                  disabled={!canPresent}
                  className={cn(
                    'block w-full overflow-hidden rounded-lg ring-2 transition-colors',
                    index === current ? 'ring-brand-400' : 'ring-transparent hover:ring-white/20',
                    !canPresent && 'cursor-default',
                  )}
                >
                  <span className="relative block aspect-video bg-ink">
                    {slide.kind === 'live' ? (
                      live && <LiveThumb pageId={slide.id} render={live.render} />
                    ) : (
                      slide.url && (
                        // Same CORS load as the stage, so the cache never holds a
                        // plain copy that would make the stage's CORS load fail.
                        <CorsImage
                          src={slide.url}
                          alt={slide.filename}
                          loading="lazy"
                          className="absolute inset-0 size-full object-contain"
                        />
                      )
                    )}
                    <span className="absolute start-1.5 top-1.5 rounded bg-black/70 px-1.5 text-[10px] text-white">
                      {index + 1}
                    </span>
                  </span>
                </button>

                {/* Sibling of the thumbnail button, not inside it: a button
                    inside a button is invalid and swallows the click. */}
                {canPresent && (
                  <button
                    type="button"
                    onClick={() => void remove(slide)}
                    disabled={removing !== null}
                    title={t('slideRemove')}
                    className="absolute end-1.5 top-1.5 inline-flex size-7 items-center justify-center rounded-md bg-black/70 text-white/70 transition-colors hover:bg-red-600 hover:text-white disabled:opacity-40"
                  >
                    {removing === slide.id ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    )}
                    <span className="sr-only">{t('slideRemove')}</span>
                  </button>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
