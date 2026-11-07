'use client';

import { useEffect, useRef, useState } from 'react';
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
import { groupAt, groupDeck, type DeckGroup } from '@/lib/live/deck-groups';
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
  /** The page on stage, in the list. */
  const activeItem = useRef<HTMLLIElement | null>(null);
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

  // One section per file. The PDF on stage is open; the others are folded
  // under their names, one click from coming back — where the teacher left
  // them, not at page one.
  const groups = groupDeck(items);
  const currentGroup = groupAt(groups, current);
  const currentKey = currentGroup?.key ?? null;
  const currentId = items[current]?.id ?? null;
  /** null follows the stage; '' is the teacher folding even the open one away. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const shownKey = openKey ?? currentKey ?? groups[groups.length - 1]?.key ?? null;
  /** The last page shown in each file, so going back resumes there. */
  const lastSeen = useRef(new Map<string, string>());

  useEffect(() => {
    setOpenKey(null);
  }, [currentKey]);

  useEffect(() => {
    if (currentKey && currentId) lastSeen.current.set(currentKey, currentId);
  }, [currentKey, currentId]);

  const openGroup = (group: DeckGroup) => {
    if (group.key === shownKey) {
      setOpenKey('');
      return;
    }
    setOpenKey(group.key);
    if (!canPresent || group.key === currentKey) return;
    const remembered = lastSeen.current.get(group.key);
    const at = remembered ? items.findIndex((item) => item.id === remembered) : -1;
    onGo(at >= group.start && at < group.start + group.count ? at : group.start);
  };

  // The list follows the page on stage. A PDF opened mid-lesson lands after
  // every page already open — after a 450-page deck that is far below the
  // fold, and the teacher could not see that it had opened, nor find the
  // first one again without scrolling by hand.
  useEffect(() => {
    // The list scrolls itself, never its ancestors: `scrollIntoView` also
    // scrolled the room's clipped box and slid the whole page sideways.
    const item = activeItem.current;
    const list = item?.closest<HTMLElement>('[data-slides-list]');
    if (!item || !list) return;
    const itemBox = item.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    if (itemBox.top < listBox.top) list.scrollTop -= listBox.top - itemBox.top + 8;
    else if (itemBox.bottom > listBox.bottom) list.scrollTop += itemBox.bottom - listBox.bottom + 8;
  }, [current, total, shownKey]);

  const liveErrorText = (failure: LiveDeckError) => {
    switch (failure.code) {
      case 'duplicate':
        return t('errors.liveDuplicate', { name: failure.name });
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
    <label className="m-3 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-room-line bg-room-raised/40 p-5 text-center transition-colors hover:border-room-blue hover:bg-room-raised">
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
            <div className="flex items-center gap-2 border-b border-room-line/70 p-2">
              <button
                type="button"
                onClick={() => onGo(current - 1)}
                disabled={!currentGroup || current <= currentGroup.start}
                className="inline-flex size-8 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 disabled:opacity-30"
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
                <span className="sr-only">{t('slidePrev')}</span>
              </button>
              {/* Counted within the PDF on stage, like the pager under the slide. */}
              <p className="min-w-0 flex-1 truncate text-center text-[12px] text-white/60">
                {currentGroup
                  ? `${current - currentGroup.start + 1} / ${currentGroup.count}`
                  : `– / ${total}`}
              </p>
              <button
                type="button"
                onClick={() => onGo(currentGroup ? current + 1 : 0)}
                disabled={
                  currentGroup ? current >= currentGroup.start + currentGroup.count - 1 : total === 0
                }
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

          <ol data-slides-list className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {groups.map((group) => {
              const open = group.key === shownKey;
              const onStage = group.key === currentKey;
              const first = items[group.start];
              return (
                <li
                  key={group.key}
                  className={cn(
                    'overflow-hidden rounded-lg border',
                    onStage
                      ? 'border-room-blue/60 bg-room-raised/70'
                      : 'border-room-line/70 bg-room-raised/30',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => openGroup(group)}
                    aria-expanded={open}
                    title={group.title}
                    className="flex w-full items-center gap-2.5 p-2 text-start transition-colors hover:bg-white/5"
                  >
                    <ChevronRight
                      className={cn(
                        'size-4 shrink-0 text-white/50 transition-transform rtl:-scale-x-100',
                        open && 'rotate-90',
                      )}
                      aria-hidden="true"
                    />
                    <span className="relative aspect-video w-14 shrink-0 overflow-hidden rounded bg-black">
                      {first?.kind === 'live'
                        ? live && <LiveThumb pageId={first.id} render={live.render} />
                        : first?.url && (
                            <CorsImage
                              src={first.url}
                              alt=""
                              loading="lazy"
                              className="absolute inset-0 size-full object-contain"
                            />
                          )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-white">
                        {group.title}
                      </span>
                      <span className="block text-[11px] text-white/45">
                        {t('slidesPages', { count: group.count })}
                      </span>
                    </span>
                    {onStage && (
                      <span className="shrink-0 rounded bg-room-blue px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        {t('slidesOnStage')}
                      </span>
                    )}
                  </button>

                  {open && (
                    <ol className="space-y-2 px-2 pb-2">
                      {items.slice(group.start, group.start + group.count).map((slide, offset) => {
                        const index = group.start + offset;
                        return (
                        <li
                          key={slide.id}
                          ref={index === current ? activeItem : undefined}
                          className="relative"
                        >
                          <button
                            type="button"
                            onClick={() => canPresent && onGo(index)}
                            disabled={!canPresent}
                            className={cn(
                              'block w-full overflow-hidden rounded-lg ring-2 transition-colors',
                              index === current ? 'ring-room-blue' : 'ring-transparent hover:ring-white/25',
                              !canPresent && 'cursor-default',
                            )}
                          >
                            <span className="relative block aspect-video bg-black">
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
                                {index - group.start + 1}
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
                        );
                      })}
                    </ol>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}
