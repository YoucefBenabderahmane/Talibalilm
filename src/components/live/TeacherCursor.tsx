'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { MousePointer2 } from 'lucide-react';
import { fitRect, type Rect } from '@/lib/live/zoom';
import type { CursorFeed, CursorPosition } from '@/lib/live/cursor-feed';

/** How long a position is shown after the last one arrived. */
const STALE_MS = 3000;

/**
 * The page the slide is drawn on, in viewport coordinates: the picture inside
 * the letterboxed `<img>` or `<video>`, or the teacher's canvas. Found in the
 * DOM at each use rather than passed down, because the element changes with
 * every page and the stage is not told which it is.
 */
export function slidePageRect(container: HTMLElement): Rect | null {
  const element = container.querySelector<HTMLImageElement | HTMLVideoElement | HTMLCanvasElement>(
    'img, video, canvas',
  );
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (element instanceof HTMLImageElement) {
    return fitRect(box, element.naturalWidth, element.naturalHeight);
  }
  if (element instanceof HTMLVideoElement) {
    return fitRect(box, element.videoWidth, element.videoHeight);
  }
  return fitRect(box, element.width, element.height);
}

/**
 * The teacher's pointer over the slide, on a student's screen.
 *
 * A teacher reading a dense page points at the line she is on, and the class
 * used to see nothing of it: her pointer never left her screen. Positions
 * arrive as fractions of the page; this places them on this browser's copy,
 * at this browser's zoom, by measuring where the page is each time. It
 * re-measures on every message and whenever the view changes, so a student
 * who pinches in sees the pointer stay on the same word.
 *
 * It fades after three seconds without news: a teacher who stopped moving
 * is not pointing any more, and a pointer stuck on an old line misleads.
 */
export function TeacherCursor({
  feed,
  container,
  view,
}: {
  feed: CursorFeed;
  container: RefObject<HTMLElement | null>;
  /** The zoom and pan in force, so a change re-measures the page. */
  view: { scale: number; x: number; y: number };
}) {
  const t = useTranslations('live');
  const [position, setPosition] = useState<CursorPosition | null>(() => feed.get());
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);
  const stale = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = feed.subscribe((next) => {
      setPosition(next);
      if (stale.current) window.clearTimeout(stale.current);
      stale.current = next ? window.setTimeout(() => setPosition(null), STALE_MS) : null;
    });
    return () => {
      unsubscribe();
      if (stale.current) window.clearTimeout(stale.current);
    };
  }, [feed]);

  useEffect(() => {
    const element = container.current;
    if (!position || !element) {
      setSpot(null);
      return;
    }
    const place = () => {
      const page = slidePageRect(element);
      if (!page) {
        setSpot(null);
        return;
      }
      const box = element.getBoundingClientRect();
      setSpot({
        left: page.left - box.left + position.x * page.width,
        top: page.top - box.top + position.y * page.height,
      });
    };
    place();
    // A page still loading has no size yet; measure again once it does.
    const media = element.querySelector('img, video');
    const onReady = () => place();
    media?.addEventListener('load', onReady);
    media?.addEventListener('loadedmetadata', onReady);
    window.addEventListener('resize', onReady);
    return () => {
      media?.removeEventListener('load', onReady);
      media?.removeEventListener('loadedmetadata', onReady);
      window.removeEventListener('resize', onReady);
    };
  }, [position, container, view]);

  if (!spot) return null;

  return (
    <div
      data-teacher-cursor
      aria-hidden="true"
      className="pointer-events-none absolute z-20 flex items-start"
      style={{ left: spot.left, top: spot.top }}
    >
      <MousePointer2
        className="size-6 fill-gold-400 text-black drop-shadow-[0_1px_2px_rgba(0,0,0,.8)]"
        strokeWidth={1.5}
      />
      <span className="mt-4 -ms-1 rounded-full bg-gold-400 px-1.5 py-0.5 text-[10px] font-semibold text-black shadow">
        {t('teacherCursor')}
      </span>
    </div>
  );
}
