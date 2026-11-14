'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CorsImage } from './CorsImage';
import { useTranslations } from 'next-intl';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize2,
  Minimize2,
  Presentation,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Track, type Participant, type Room } from 'livekit-client';
import { cn } from '@/lib/utils';
import {
  clampPan,
  MAX_ZOOM,
  MIN_ZOOM,
  nextZoom,
  normalizePoint,
  steppedZoom,
  zoomAbout,
} from '@/lib/live/zoom';
import type { CursorFeed, CursorPosition } from '@/lib/live/cursor-feed';
import { SharePip } from './SharePip';
import { SlidePen, type SlideAnnotate } from './SlidePen';
import { StageCamera } from './StageCamera';
import { slidePageRect, TeacherCursor } from './TeacherCursor';
import { VideoTile } from './VideoTile';
import type { RoomPerson } from './useRoom';

/**
 * What the slide area holds: a page of the uploaded deck, or a page of the
 * teacher's live deck — her own canvas on her screen, the "slides" video track
 * on everyone else's. Both get the same zoom, fullscreen and pager.
 */
export type SlideContent =
  | { kind: 'image'; src: string }
  /** `key` names the page, so a zoom made on one page does not carry to the next. */
  | { kind: 'live'; key: string; node: ReactNode };

/**
 * What the class is looking at.
 *
 * A lesson is not a meeting of equals, so the layout is not an even grid. When
 * something is being presented — a shared screen, the slide deck, or a person
 * the teacher has brought onto the stage — it takes the big box and everyone
 * else becomes a strip. Otherwise the teacher is large and the students are
 * small, which is what a class looks like.
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
  sharePip,
  onMinimizeShare,
  onExpandShare,
  staged,
  onStage,
  annotate,
  cursorFeed,
  onCursor,
}: {
  room: Room;
  people: RoomPerson[];
  /** Identity of whoever is sharing a screen, if anyone. */
  presenting: string | null;
  /** The current slide, when the teacher is presenting the deck. */
  slide: SlideContent | null;
  /** The host alone gets the pager and the keyboard. */
  canPresent: boolean;
  slideIndex: number;
  slideTotal: number;
  onGoSlide: (index: number) => void;
  /** True when a running share is reduced to the corner rather than on stage. */
  sharePip: boolean;
  onMinimizeShare: () => void;
  onExpandShare: () => void;
  /** Identity of the person the teacher has put on the stage — a student or herself — or null. */
  staged: string | null;
  /** The host alone moves people on and off the stage. */
  onStage: (identity: string | null) => void;
  /** The teacher's pen, when the slide on stage is one she can draw on. */
  annotate?: SlideAnnotate;
  /** A student's stage: where the teacher's pointer is on the slide. */
  cursorFeed?: CursorFeed;
  /** The teacher's stage: tells the class where her pointer is. */
  onCursor?: (position: CursorPosition | null) => void;
}) {
  const t = useTranslations('live');
  const byIdentity = (identity: string): Participant | undefined =>
    identity === room.localParticipant.identity
      ? room.localParticipant
      : room.remoteParticipants.get(identity);

  const host = people.find((p) => p.isHost);
  const sharer = presenting ? people.find((p) => p.identity === presenting) : undefined;
  // One content at a time: the share owns the stage only while it has not been
  // reduced. Reduced, the slide (or the teacher) takes it and the share keeps
  // running in the corner.
  const focusIsShare = Boolean(sharer) && !sharePip;
  const stagedPerson = staged ? people.find((p) => p.identity === staged) : undefined;

  // The strip: cameras on first. The sharer keeps their own camera here —
  // sharing a screen must not make the teacher vanish from their own class —
  // and the student on the big stage is not repeated below it. A student who
  // is staged but hidden behind an expanded share stays in the strip, so the
  // teacher never loses track of them.
  const strip = people
    .filter((p) => !(stagedPerson && !focusIsShare && p.identity === stagedPerson.identity))
    .filter((p) => (focusIsShare || stagedPerson || slide ? true : p.identity !== host?.identity))
    .filter((p) => p.camOn || p.isLocal || p.handUp || p.speaking)
    .slice(0, 12);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div
        data-record-container
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black"
      >
        {sharer && !sharePip ? (
          (() => {
            const p = byIdentity(sharer.identity);
            return p ? (
              <>
                <VideoTile
                  participant={p}
                  person={sharer}
                  source={Track.Source.ScreenShare}
                  record="main"
                  className="size-full rounded-none bg-black ring-0"
                />
                {canPresent && (
                  <button
                    type="button"
                    onClick={onMinimizeShare}
                    title={t('shareMinimize')}
                    className="absolute end-3 top-3 rounded-md bg-black/60 p-2 text-white/80 transition-colors hover:bg-black/80 hover:text-white"
                  >
                    <Minimize2 className="size-4" aria-hidden="true" />
                    <span className="sr-only">{t('shareMinimize')}</span>
                  </button>
                )}
              </>
            ) : null;
          })()
        ) : stagedPerson ? (
          (() => {
            const p = byIdentity(stagedPerson.identity);
            return p ? (
              <StageCamera
                participant={p}
                person={stagedPerson}
                canMinimize={canPresent}
                onMinimize={() => onStage(null)}
              />
            ) : null;
          })()
        ) : slide ? (
          <SlideStage
            content={slide}
            canPresent={canPresent}
            index={slideIndex}
            total={slideTotal}
            onGo={onGoSlide}
            annotate={annotate}
            cursorFeed={cursorFeed}
            onCursor={onCursor}
          />
        ) : slideIndex >= 0 ? (
          // The deck arrives without links and the page on stage is signed on
          // demand, so there is a moment with an index but no image. Showing
          // the teacher's camera for it read as the slide having vanished.
          <div className="flex size-full items-center justify-center">
            <Loader2 className="size-6 animate-spin text-white/40" aria-hidden="true" />
          </div>
        ) : host ? (
          (() => {
            const p = byIdentity(host.identity);
            return p ? (
              <VideoTile
                participant={p}
                person={host}
                record="main"
                className="size-full rounded-none ring-0"
              />
            ) : null;
          })()
        ) : (
          <div className="flex size-full items-center justify-center px-6 text-center">
            <p className="max-w-xs text-sm text-white/50">…</p>
          </div>
        )}

        {/* The reduced share, over whatever took the stage. Its own expand
            button puts it back — replacing the slide, not stacking on it. */}
        {sharer && sharePip && (
          <SharePip
            room={room}
            person={sharer}
            canExpand={canPresent}
            onExpand={onExpandShare}
          />
        )}
      </div>

      {strip.length > 0 && (
        // A filmstrip of small tiles, as in a meeting app: the lesson keeps the
        // room, and the strip scrolls sideways once it is full. The automatic
        // margins centre it without hiding the first tiles when it overflows.
        <ul
          className={cn(
            'flex shrink-0 gap-2 overflow-x-auto pb-0.5',
            '[&>li]:aspect-video [&>li]:w-36 [&>li]:shrink-0 sm:[&>li]:w-44',
            '[&>li:first-child]:ms-auto [&>li:last-child]:me-auto',
          )}
        >
          {strip.map((person) => {
            const p = byIdentity(person.identity);
            if (!p) return null;
            return (
              <li key={person.identity} className="relative">
                <VideoTile participant={p} person={person} className="size-full" />
                {/* The teacher's quick way onto the big box: an expand control
                    on each student's tile, the same posture as the share's —
                    and on her own, which is how she takes the big box back
                    from a slide or a shared screen. */}
                {canPresent && (!person.isHost || person.isLocal) && (
                  <button
                    type="button"
                    onClick={() => onStage(person.identity)}
                    title={t('studentOnStage')}
                    className="absolute end-1.5 top-1.5 rounded-md bg-black/60 p-1.5 text-white/80 transition-colors hover:bg-black/80 hover:text-white"
                  >
                    <Presentation className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">{t('studentOnStage')}</span>
                  </button>
                )}
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
 * stopped, and a passive listener cannot do that. On a phone the same zoom is
 * a pinch, a double-tap on the spot to look at, and the + / − buttons, because
 * a student following from a phone had no wheel and `touch-none` had taken
 * the browser's own pinch away.
 *
 * The teacher's pointer is shared: her stage sends where it is on the page,
 * a student's stage draws it there (TeacherCursor). That is how the class
 * follows the line she is reading from.
 *
 * The pager is the host's alone, exactly like Zoom's presenter toolbar: the
 * class follows the teacher's page through the same `slide` message the side
 * panel already sends, so students need no controls and cannot take the lesson
 * off course.
 *
 * It sits in a row of its own under the image rather than floating over it. A
 * floating pill covered the bottom of a dense page — the table rows and foot-
 * notes a teacher points at — which is the one part of a slide that must never
 * be hidden. The zoom surface clips for the same reason: a page pushed in with
 * the wheel used to spill over the pager row and put the pill back on the
 * slide.
 */
function SlideStage({
  content,
  canPresent,
  index,
  total,
  onGo,
  annotate,
  cursorFeed,
  onCursor,
}: {
  content: SlideContent;
  canPresent: boolean;
  index: number;
  total: number;
  onGo: (index: number) => void;
  annotate?: SlideAnnotate;
  cursorFeed?: CursorFeed;
  onCursor?: (position: CursorPosition | null) => void;
}) {
  const t = useTranslations('live');
  const container = useRef<HTMLDivElement>(null);
  /**
   * The element that goes fullscreen: the image AND the pager. Requesting it
   * on the image alone would take the page controls away at the moment the
   * teacher needs them most.
   */
  const wrapper = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  /** Every pointer down on the surface, so two fingers read as a pinch. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** The pinch in progress: the fingers' last distance and midpoint. */
  const pinch = useRef<{ distance: number; mid: { x: number; y: number } } | null>(null);
  /** The last tap, to tell a double-tap from two taps. */
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });

  /** A point measured from the container's centre, where the transform pivots. */
  const centred = (rect: DOMRect, clientX: number, clientY: number) => ({
    x: clientX - rect.left - rect.width / 2,
    y: clientY - rect.top - rect.height / 2,
  });

  /** The + and − buttons zoom about the centre of what is on screen. */
  const step = (direction: 1 | -1) => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    setView((current) =>
      zoomAbout(current, steppedZoom(current.scale, direction), { x: 0, y: 0 }, rect.width, rect.height),
    );
  };
  const [fullscreen, setFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  /** What the page box holds while it is being typed in. */
  const [draft, setDraft] = useState(String(index + 1));

  // `document.fullscreenEnabled` is false where the API is refused (an iPhone
  // browser, an embedded frame); the control hides rather than failing.
  useEffect(() => {
    setCanFullscreen(Boolean(document.fullscreenEnabled));
  }, []);

  // Esc leaves fullscreen without going through the button, so the icon is
  // driven by the document's state, not by our last click.
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapper.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    const element = wrapper.current;
    if (!element) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    void element.requestFullscreen().catch(() => {});
  };

  // A zoom belongs to the page it was made on. The next page opens fitted.
  const page = content.kind === 'image' ? content.src : content.key;
  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 });
  }, [page]);

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
      // Keep the point under the pointer where it is: zooming about the
      // centre means pushing in on a corner throws it off screen.
      setView((current) =>
        zoomAbout(
          current,
          // ctrlKey on a wheel event is how a trackpad pinch arrives.
          nextZoom(current.scale, event.deltaY, event.ctrlKey),
          centred(rect, event.clientX, event.clientY),
          rect.width,
          rect.height,
        ),
      );
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  // The teacher's pointer, shared with the class. Native listeners in the
  // capture phase: the pen layer stops the propagation of its own pointer
  // events, and the pointer has to be seen through it. Twenty-five times a
  // second at most, as fractions of the page; off when it leaves the page.
  useEffect(() => {
    const element = container.current;
    if (!element || !canPresent || !onCursor) return;
    const EVERY = 40;
    let last = 0;
    let shown = false;
    let latest: { x: number; y: number } | null = null;
    let timer: number | null = null;

    const tell = (position: { x: number; y: number } | null) => {
      last = performance.now();
      if (position) {
        shown = true;
        onCursor(position);
      } else if (shown) {
        shown = false;
        onCursor(null);
      }
    };
    // The last position is the one that matters — it is where she stopped,
    // on the word she means — so a move inside the window is not dropped but
    // held and sent when the window ends.
    const onMove = (event: PointerEvent) => {
      const page = slidePageRect(element);
      latest = page ? normalizePoint(event.clientX, event.clientY, page) : null;
      const wait = EVERY - (performance.now() - last);
      if (wait <= 0) {
        tell(latest);
        return;
      }
      if (timer === null) {
        timer = window.setTimeout(() => {
          timer = null;
          tell(latest);
        }, wait);
      }
    };
    const onLeave = () => {
      latest = null;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      tell(null);
    };
    element.addEventListener('pointermove', onMove, true);
    element.addEventListener('pointerleave', onLeave);
    return () => {
      element.removeEventListener('pointermove', onMove, true);
      element.removeEventListener('pointerleave', onLeave);
      if (timer !== null) window.clearTimeout(timer);
      if (shown) onCursor(null);
    };
  }, [canPresent, onCursor]);

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
    <div ref={wrapper} className="flex size-full flex-col bg-black">
      <div
        ref={container}
        className="relative min-h-0 flex-1 touch-none overflow-hidden"
        style={{ cursor: view.scale > 1 ? (drag.current ? 'grabbing' : 'grab') : 'default' }}
        onPointerDown={(event) => {
          // The controls live inside the zoom surface; a drag started on one
          // would capture the pointer and swallow the click.
          if ((event.target as HTMLElement).closest('button, input')) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size === 2) {
            // Two fingers: a pinch, never a drag.
            drag.current = null;
            const [a, b] = [...pointers.current.values()];
            if (!a || !b) return;
            pinch.current = {
              distance: Math.hypot(a.x - b.x, a.y - b.y),
              mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            return;
          }
          if (view.scale <= 1) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, panX: view.x, panY: view.y };
        }}
        onPointerMove={(event) => {
          if (pointers.current.has(event.pointerId)) {
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const held = pinch.current;
          const [a, b] = held ? [...pointers.current.values()] : [];
          if (held && a && b) {
            const distance = Math.hypot(a.x - b.x, a.y - b.y);
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            if (distance > 0 && held.distance > 0) {
              // Zoom by how much the fingers spread, about where they are,
              // then follow them: the page stays under the hand.
              const ratio = distance / held.distance;
              const shift = { x: mid.x - held.mid.x, y: mid.y - held.mid.y };
              setView((current) => {
                const zoomed = zoomAbout(
                  current,
                  current.scale * ratio,
                  centred(rect, mid.x, mid.y),
                  rect.width,
                  rect.height,
                );
                const pan = clampPan(
                  { x: zoomed.x + shift.x, y: zoomed.y + shift.y },
                  zoomed.scale,
                  rect.width,
                  rect.height,
                );
                return { scale: zoomed.scale, x: pan.x, y: pan.y };
              });
            }
            pinch.current = { distance, mid };
            return;
          }
          const start = drag.current;
          if (!start) return;
          setView((current) => {
            const pan = clampPan(
              {
                x: start.panX + (event.clientX - start.x),
                y: start.panY + (event.clientY - start.y),
              },
              current.scale,
              rect.width,
              rect.height,
            );
            return { ...current, x: pan.x, y: pan.y };
          });
        }}
        onPointerUp={(event) => {
          const wasPinching = pinch.current !== null;
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          drag.current = null;
          // A double-tap zooms in on the spot, or back out to the fitted
          // page — the gesture every phone has taught. Touch only: a mouse
          // has the wheel, and a double-click on a slide should do nothing.
          if (event.pointerType !== 'touch' || wasPinching || pointers.current.size > 0) return;
          const now = Date.now();
          const last = lastTap.current;
          if (
            last &&
            now - last.at < 320 &&
            Math.hypot(event.clientX - last.x, event.clientY - last.y) < 30
          ) {
            lastTap.current = null;
            const rect = event.currentTarget.getBoundingClientRect();
            const point = centred(rect, event.clientX, event.clientY);
            setView((current) =>
              current.scale > 1
                ? { scale: 1, x: 0, y: 0 }
                : zoomAbout(current, 2.5, point, rect.width, rect.height),
            );
          } else {
            lastTap.current = { at: now, x: event.clientX, y: event.clientY };
          }
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          drag.current = null;
        }}
      >
        {content.kind === 'image' ? (
          // Loaded under CORS when the bucket allows it, so the recording can
          // include the slide; see CorsImage.
          <CorsImage
            src={content.src}
            alt=""
            draggable={false}
            data-record="main"
            className="size-full object-contain select-none"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          />
        ) : (
          <div
            className="size-full"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          >
            {content.node}
          </div>
        )}

        {/* The pen draws on the page the class is watching: live pages only. */}
        {canPresent && annotate && content.kind === 'live' && <SlidePen {...annotate} />}

        {/* The teacher's pointer, on a student's copy of the page. */}
        {!canPresent && cursorFeed && (
          <TeacherCursor feed={cursorFeed} container={container} view={view} />
        )}

        <div className="absolute end-3 top-3 flex flex-col items-end gap-2">
          {canFullscreen && (
            <button
              type="button"
              onClick={toggleFullscreen}
              title={fullscreen ? t('slideExitFullscreen') : t('slideFullscreen')}
              aria-pressed={fullscreen}
              className="rounded-full bg-black/60 p-2 text-white/80 transition-colors hover:text-white"
            >
              {fullscreen ? (
                <Minimize2 className="size-4" aria-hidden="true" />
              ) : (
                <Maximize2 className="size-4" aria-hidden="true" />
              )}
              <span className="sr-only">
                {fullscreen ? t('slideExitFullscreen') : t('slideFullscreen')}
              </span>
            </button>
          )}

          {/* + and −, for the hands without a wheel. */}
          <div className="flex flex-col overflow-hidden rounded-full bg-black/60">
            <button
              type="button"
              onClick={() => step(1)}
              disabled={view.scale >= MAX_ZOOM}
              title={t('slideZoomIn')}
              className="p-2 text-white/80 transition-colors hover:text-white disabled:opacity-30"
            >
              <ZoomIn className="size-4" aria-hidden="true" />
              <span className="sr-only">{t('slideZoomIn')}</span>
            </button>
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={view.scale <= MIN_ZOOM}
              title={t('slideZoomOut')}
              className="p-2 text-white/80 transition-colors hover:text-white disabled:opacity-30"
            >
              <ZoomOut className="size-4" aria-hidden="true" />
              <span className="sr-only">{t('slideZoomOut')}</span>
            </button>
          </div>

          {view.scale > 1 && (
            <button
              type="button"
              onClick={() => setView({ scale: 1, x: 0, y: 0 })}
              title={t('slideZoomReset')}
              className="rounded-full bg-black/60 px-3 py-1 text-[11px] text-white/80 transition-colors hover:text-white"
            >
              {t('slideZoomReset')} · {Math.round(view.scale * 100)}%
            </button>
          )}
        </div>
      </div>

      {canPresent && total > 1 && (
        <div className="mx-auto my-2 flex shrink-0 items-center gap-1 rounded-full bg-black/60 px-1.5 py-1 text-white backdrop-blur">
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
