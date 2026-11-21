'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { completeLesson, saveLessonPosition } from '@/app/actions/progress';

/** How often the position is written while the recording plays, in seconds. */
const SAVE_EVERY = 60;
/** Resuming a few seconds in, or a few seconds from the end, helps nobody. */
const RESUME_MIN = 5;
const RESUME_TAIL = 10;

/**
 * An uploaded recording that remembers where the student was, and finishes
 * the lesson when it has been watched to the end.
 *
 * Two things the plain `<video>` could not do. A class runs up to two hours;
 * reopening it at 0:00 every time meant finding one's place by hand. And a
 * student who had just watched the whole recording was still asked to say so.
 *
 * The position is written once a minute while playing, and at once on pause
 * and when the tab is hidden — not every few seconds: each write is a function
 * invocation, and a minute lost after a crash is a fair price for not paying
 * for sixty of them an hour per viewer.
 *
 * The signed URL is kept from the first render. The page re-signs it on every
 * server render — including the refresh that follows the lesson being marked
 * finished — and handing the player a new `src` would restart the recording.
 * The page keys this component by lesson, so another lesson gets its own.
 */
export function LessonVideo({
  src,
  lessonId,
  startAt,
  completed,
}: {
  src: string;
  lessonId: string;
  /** Seconds already watched, from the student's progress row. */
  startAt: number;
  completed: boolean;
}) {
  const router = useRouter();
  const video = useRef<HTMLVideoElement>(null);
  const [stableSrc] = useState(src);
  const lastSaved = useRef(startAt);
  const restored = useRef(false);
  const finished = useRef(completed);

  const save = useCallback(
    (force: boolean) => {
      const element = video.current;
      if (!element || !Number.isFinite(element.currentTime)) return;
      const seconds = Math.floor(element.currentTime);
      if (seconds === lastSaved.current) return;
      if (!force && Math.abs(seconds - lastSaved.current) < SAVE_EVERY) return;
      lastSaved.current = seconds;
      void saveLessonPosition(lessonId, seconds);
    },
    [lessonId],
  );

  // A tab sent to the background may never come back: note the place now.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') save(true);
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
    };
  }, [save]);

  const restore = () => {
    const element = video.current;
    if (!element || restored.current) return;
    restored.current = true;
    const { duration } = element;
    if (startAt < RESUME_MIN) return;
    // A live-style stream reports an infinite duration; there the position is
    // still a real offset, so only a known end rules a resume out.
    if (Number.isFinite(duration) && startAt > duration - RESUME_TAIL) return;
    element.currentTime = startAt;
  };

  const onEnded = async () => {
    // Watched to the end: the next visit starts from the beginning.
    lastSaved.current = 0;
    void saveLessonPosition(lessonId, 0);
    if (finished.current) return;
    finished.current = true;
    const result = await completeLesson(lessonId);
    if (result.ok) {
      router.refresh();
    } else {
      // Not recorded: let the button say so rather than pretending.
      finished.current = false;
    }
  };

  return (
    <video
      ref={video}
      src={stableSrc}
      controls
      preload="metadata"
      controlsList="nodownload"
      className="block aspect-video w-full"
      data-testid="lesson-video"
      onLoadedMetadata={restore}
      onTimeUpdate={() => save(false)}
      onPause={() => {
        // `pause` also fires as the recording ends; `ended` handles that.
        if (!video.current?.ended) save(true);
      }}
      onEnded={() => void onEnded()}
    />
  );
}
