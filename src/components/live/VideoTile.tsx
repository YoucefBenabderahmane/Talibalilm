'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Track, type Participant } from 'livekit-client';
import { Hand, Mic, MicOff, MonitorUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAttachedTrack } from './useAttachedTrack';
import type { RoomPerson } from './useRoom';

/**
 * One person on screen.
 *
 * The video element is attached imperatively because a MediaStreamTrack is not
 * React state — re-rendering must not detach and reattach it, which would show
 * a black flash every time somebody else raises a hand.
 *
 * A tile with no camera is not an empty box: it shows the person's initials, so
 * a class of forty with cameras off still reads as a room full of people rather
 * than a wall of nothing.
 */
export function VideoTile({
  participant,
  person,
  source = Track.Source.Camera,
  className,
  record,
}: {
  participant: Participant;
  person: RoomPerson;
  source?: Track.Source;
  className?: string;
  /**
   * Marks this tile as part of the recording. `main` is what the lesson is on;
   * `pip` is the reduced share in the corner. The recorder composites every
   * marker, so the file shows what the class saw.
   */
  record?: 'main' | 'pip';
}) {
  const t = useTranslations('live');
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useAttachedTrack(participant, source, videoRef);

  const initials = (person.name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  const showVideo = source === Track.Source.ScreenShare ? person.sharing : person.camOn;

  return (
    <div
      className={cn(
        '@container relative overflow-hidden rounded-lg bg-room-raised ring-1 ring-black/40',
        // The one who is talking is framed in green, as in every meeting app.
        person.speaking && 'ring-[3px] ring-room-green',
        className,
      )}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={person.isLocal}
        data-record={record}
        className={cn(
          'size-full',
          // A shared screen is letterboxed, never cropped: `object-cover` cut
          // the edges off a document, which is the part being pointed at. A
          // camera fills its tile.
          source === Track.Source.ScreenShare ? 'object-contain' : 'object-cover',
          !showVideo && 'hidden',
        )}
      />

      {!showVideo && (
        <div className="flex size-full items-center justify-center">
          <span className="flex aspect-square h-[38%] max-h-24 min-h-8 -translate-y-1 items-center justify-center rounded-full bg-room-line text-[clamp(0.8rem,6cqw,2rem)] font-semibold text-white/90">
            {initials}
          </span>
        </div>
      )}

      <div className="absolute start-1.5 bottom-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1.5 rounded bg-black/65 px-1.5 py-0.5">
        {person.micOn ? (
          <Mic className="size-3.5 shrink-0 text-white/80" aria-hidden="true" />
        ) : (
          <MicOff className="size-3.5 shrink-0 text-red-500" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate text-[12px] text-white">
          {person.name}
          {person.isLocal && ' •'}
        </span>
        {person.handUp && <Hand className="size-3.5 shrink-0 text-gold-400" aria-hidden="true" />}
        {person.sharing && source !== Track.Source.ScreenShare && (
          <MonitorUp className="size-3.5 shrink-0 text-room-green" aria-hidden="true" />
        )}
        {person.isHost && (
          <span className="shrink-0 rounded-sm bg-room-blue px-1 py-px text-[9px] font-semibold tracking-wide text-white uppercase">
            {t('host')}
          </span>
        )}
      </div>
    </div>
  );
}
