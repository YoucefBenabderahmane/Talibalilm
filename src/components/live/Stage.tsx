'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Track, type Participant, type Room } from 'livekit-client';
import { cn } from '@/lib/utils';
import { clampPan, nextZoom } from '@/lib/live/zoom';
import { VideoTile } from './VideoTile';
import type { RoomPerson } from './useRoom';

/**
 * What the class is looking at.
 *
 * A lesson is not a meeting of equals, so the layout is not an even grid. When
 * something is being presented — a shared screen, or the slide deck — it takes
 * the stage and everyone else becomes a strip. Otherwise the teacher is large
 * and the students are small, which is what a class looks like.
 *
 * Only participants whose video is actually flowing get a tile of their own in
 * the strip; forty cameras-off tiles would be forty empty boxes pushing the
 * lesson off the screen, so they are counted in the participants panel instead.
 */
export function Stage({
  room,
  people,
  presenting,
  slide,
  canPresent,
  slideIndex,
  slideTotal,
  onGoSlide,
}: {
  room: Room;
  people: RoomPerson[];
  /** Identity of whoever is sharing a screen, if anyone. */
  presenting: string | null;
  /** The current slide's image, when the teacher is presenting the deck. */
  slide: string | null;
  /** The host alone gets the pager and the keyboard. */
  canPresent: boolean;
  slideIndex: number;
  slideTotal: number;
  onGoSlide: (index: number) => void;
}) {
  const byIdentity = (identity: string): Participant | undefined =>
    identity === room.localParticipant.identity
      ? room.localParticipant
      : room.remoteParticipants.get(identity);

  const host = people.find((p) => p.isHost);
  const sharer = presenting ? people.find((p) => p.identity === presenting) : undefined;
  const focusIsShare = Boolean(sharer);

  // The strip: everyone except whoever holds the stage, with cameras on first.
  const strip = people
    .filter((p) => p.identity !== sharer?.identity)
    .filter((p) => (focusIsShare || slide ? true : p.identity !== host?.identity))
    .filter((p) => p.camOn || p.isLocal || p.handUp || p.speaking)
    .slice(0, 12);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-black/30">
        {slide && !focusIsShare ? (
          <SlideStage
            src={slide}
            canPresent={canPresent}
            index={slideIndex}
            total={slideTotal}
            onGo={onGoSlide}
          />
        ) : sharer ? (
          (() => {
            const p = byIdentity(sharer.identity);
            return p ? (
              <VideoTile
                participant={p}
                person={sharer}
                source={Track.Source.ScreenShare}
                className="size-full rounded-2xl ring-0"
              />
            ) : null;
          })()
        ) : host ? (
          (() => {
            const p = byIdentity(host.identity);
            return p ? (
              <VideoTile participant={p} person={host} className="size-full rounded-2xl ring-0" />
            ) : null;
          })()
        ) : (
          <div className="flex size-full items-center justify-center px-6 text-center">
            <p className="max-w-xs text-sm text-white/50">…</p>
          </div>
        )}
      </div>

      {strip.length > 0 && (
        <ul
          className={cn(
            'grid shrink-0 gap-2',
            'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6',
            '[&>li]:aspect-video',
          )}
        >
          {strip.map((person) => {
            const p = byIdentity(person.identity);
            if (!p) return null;
            return (
              <li key={person.identity}>
                <VideoTile participant={p} person={person} className="size-full" />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The slide itself, with the teacher's two reading aids.
 *
 * Zoom is per viewer and changes nothing for anyone else — a student reading a
 * dense page can push in without moving the class. The wheel is registered by
 * hand rather than through React because the page's own scroll has to be
 * stopped, and a passive listener cannot do that.
 *
 * The pager is the host's alone, exactly like Zoom's presenter toolbar: the
 * class follows the teacher's page through the same `slide` message the side
 * panel already sends, so students need no controls and cannot take the lesson
 * off course.
 */
function SlideStage({
  src,
  canPresent,
  index,
  total,
  onGo,
}: {
  src: string;
  canPresent: boolean;
  index: number;
  total: number;
  onGo: (index: number) => void;
}) {
  const t = useTranslations('live');
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  /** What the page box holds while it is being typed in. */
  const [draft, setDraft] = useState(String(index + 1));

  // A zoom belongs to the page it was made on. The next page opens fitted.
  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 });
  }, [src]);

  // The box follows the deck: paging with the arrows or the keyboard updates
  // it, and typing never fights that because it only changes while unfocused
  // in practice — the value is committed on Enter or on leaving the field.
  useEffect(() => {
    setDraft(String(index + 1));
  }, [index]);

  const commitPage = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setDraft(String(index + 1));
      return;
    }
    const target = Math.min(total, Math.max(1, Math.round(parsed))) - 1;
    setDraft(String(target + 1));
    if (target !== index) onGo(target);
  };

  useEffect(() => {
    const element = container.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      // Otherwise the panel or the page scrolls under the pointer while the
      // teacher is trying to read a formula.
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      setView((current) => {
        const scale = nextZoom(current.scale, event.deltaY);
        if (scale === current.scale) return current;
        // Keep the point under the pointer where it is: zooming about the
        // centre means pushing in on a corner throws it off screen.
        const factor = scale / current.scale;
        const px = event.clientX - rect.left - rect.width / 2;
        const py = event.clientY - rect.top - rect.height / 2;
        const pan = clampPan(
          { x: current.x * factor + px * (1 - factor), y: current.y * factor + py * (1 - factor) },
          scale,
          rect.width,
          rect.height,
        );
        return { scale, x: pan.x, y: pan.y };
      });
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  // The host's keyboard, the way a presentation works everywhere else. Ignored
  // while the teacher is typing in the chat or renaming the room.
  useEffect(() => {
    if (!canPresent) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        onGo(Math.max(0, index - 1));
      } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        onGo(Math.min(total - 1, index + 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canPresent, index, total, onGo]);

  return (
    <div
      ref={container}
      className="relative size-full touch-none"
      style={{ cursor: view.scale > 1 ? (drag.current ? 'grabbing' : 'grab') : 'default' }}
      onPointerDown={(event) => {
        if (view.scale <= 1) return;
        // The pager and the reset control live inside the zoom surface; a drag
        // started on one of them would capture the pointer and swallow its
        // click, or the caret in the page box.
        if ((event.target as HTMLElement).closest('button, input')) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, panX: view.x, panY: view.y };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const rect = event.currentTarget.getBoundingClientRect();
        setView((current) => {
          const pan = clampPan(
            { x: start.panX + (event.clientX - start.x), y: start.panY + (event.clientY - start.y) },
            current.scale,
            rect.width,
            rect.height,
          );
          return { ...current, x: pan.x, y: pan.y };
        });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a signed URL that expires, and a transform the optimizer cannot carry */}
      <img
        src={src}
        alt=""
        draggable={false}
        className="size-full object-contain select-none"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      />

      {view.scale > 1 && (
        <button
          type="button"
          onClick={() => setView({ scale: 1, x: 0, y: 0 })}
          title={t('slideZoomReset')}
          className="absolute end-3 top-3 rounded-full bg-ink/75 px-3 py-1 text-[11px] text-white/80 transition-colors hover:text-white"
        >
          {t('slideZoomReset')} · {Math.round(view.scale * 100)}%
        </button>
      )}

      {canPresent && total > 1 && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-ink/75 px-1.5 py-1 text-white backdrop-blur">
          <button
            type="button"
            onClick={() => onGo(Math.max(0, index - 1))}
            disabled={index <= 0}
            className="inline-flex size-7 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 disabled:opacity-30"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            <span className="sr-only">{t('slidePrev')}</span>
          </button>
          {/* A page box rather than a label: a teacher with a 150-page deck
              should be able to type the page the class is on, not press an
              arrow seventy times. */}
          <span className="flex items-center gap-1 text-[12px] tabular-nums">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  setDraft(String(index + 1));
                  event.currentTarget.blur();
                }
              }}
              onBlur={commitPage}
              inputMode="numeric"
              aria-label={t('slidePage', { current: index + 1, total })}
              className="w-10 rounded bg-white/10 px-1 py-0.5 text-center text-white outline-none transition-colors focus:bg-white/20"
            />
            <span className="text-white/60">/ {total}</span>
          </span>
          <button
            type="button"
            onClick={() => onGo(Math.min(total - 1, index + 1))}
            disabled={index >= total - 1}
            className="inline-flex size-7 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 disabled:opacity-30"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
            <span className="sr-only">{t('slideNext')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
