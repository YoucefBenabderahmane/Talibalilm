'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Hand, Mic, MicOff, Minimize2 } from 'lucide-react';
import { Track, type Participant } from 'livekit-client';
import { cn } from '@/lib/utils';
import { clampPan, nextZoom } from '@/lib/live/zoom';
import { useAttachedTrack } from './useAttachedTrack';
import type { RoomPerson } from './useRoom';

/**
 * A student the teacher has brought onto the main stage.
 *
 * Fitted, not cropped: `object-contain` shows the whole picture inside the big
 * box, the same posture as the shared screen. Cropping a webcam cuts off the
 * top of the person who is speaking, which is the part the class is looking at.
 *
 * Zoom is per viewer and changes nothing for anyone else — like the slide's,
 * the wheel and the drag move only the browser they happen in. The media
 * server is not involved; nothing is renegotiated.
 *
 * The minimize control is the teacher's: whether the class watches this
 * student or the lesson is one decision, and it is theirs.
 */
export function StageCamera({
  participant,
  person,
  canMinimize,
  onMinimize,
}: {
  participant: Participant;
  person: RoomPerson;
  canMinimize: boolean;
  onMinimize: () => void;
}) {
  const t = useTranslations('live');
  const container = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });

  useAttachedTrack(participant, Track.Source.Camera, videoRef);

  // A zoom belongs to the person it was made on. The next student opens fitted.
  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 });
  }, [person.identity]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      // Otherwise the room scrolls under the pointer while the teacher is
      // trying to look closer at the student.
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      setView((current) => {
        const scale = nextZoom(current.scale, event.deltaY);
        if (scale === current.scale) return current;
        // Keep the point under the pointer where it is, exactly as the slide
        // zoom does: zooming about the centre throws a face off screen.
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

  const initials = (person.name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div
      ref={container}
      className="relative size-full touch-none overflow-hidden bg-black"
      style={{ cursor: view.scale > 1 ? (drag.current ? 'grabbing' : 'grab') : 'default' }}
      onPointerDown={(event) => {
        if (view.scale <= 1) return;
        // The controls float inside this surface; a drag started on one would
        // capture the pointer and swallow the click.
        if ((event.target as HTMLElement).closest('button')) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, panX: view.x, panY: view.y };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const rect = event.currentTarget.getBoundingClientRect();
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
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={person.isLocal}
        data-record="main"
        className={cn('size-full object-contain select-none', !person.camOn && 'hidden')}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      />

      {!person.camOn && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-20 items-center justify-center rounded-full bg-white/10 text-2xl font-semibold text-white/80">
            {initials}
          </span>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
        {person.micOn ? (
          <Mic className="size-4 shrink-0 text-white/80" aria-hidden="true" />
        ) : (
          <MicOff className="size-4 shrink-0 text-red-400" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white">
          {person.name}
          {person.isLocal && ` • ${t('you')}`}
        </span>
        {person.handUp && <Hand className="size-4 shrink-0 text-gold-400" aria-hidden="true" />}
      </div>

      <div className="absolute end-3 top-3 flex flex-col items-end gap-2">
        {canMinimize && (
          <button
            type="button"
            onClick={onMinimize}
            title={t('studentMinimize')}
            className="rounded-full bg-ink/75 p-2 text-white/80 transition-colors hover:text-white"
          >
            <Minimize2 className="size-4" aria-hidden="true" />
            <span className="sr-only">{t('studentMinimize')}</span>
          </button>
        )}
        {view.scale > 1 && (
          <button
            type="button"
            onClick={() => setView({ scale: 1, x: 0, y: 0 })}
            title={t('slideZoomReset')}
            className="rounded-full bg-ink/75 px-3 py-1 text-[11px] text-white/80 transition-colors hover:text-white"
          >
            {t('slideZoomReset')} · {Math.round(view.scale * 100)}%
          </button>
        )}
      </div>
    </div>
  );
}
