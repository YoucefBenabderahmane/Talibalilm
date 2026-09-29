'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Track, type Participant, type TrackPublication } from 'livekit-client';
import { Hand, Mic, MicOff, MonitorUp } from 'lucide-react';
import { cn } from '@/lib/utils';
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
}: {
  participant: Participant;
  person: RoomPerson;
  source?: Track.Source;
  className?: string;
}) {
  const t = useTranslations('live');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const attach = () => {
      const pub: TrackPublication | undefined = participant.getTrackPublication(source);
      if (pub?.track) pub.track.attach(video);
    };
    attach();

    const id = window.setInterval(attach, 1000); // Cheap resync when a track arrives late.
    return () => {
      window.clearInterval(id);
      const pub = participant.getTrackPublication(source);
      pub?.track?.detach(video);
    };
  }, [participant, source]);

  useEffect(() => {
    const audio = audioRef.current;
    // The local participant never plays their own microphone back — that is an
    // echo, not a feature.
    if (!audio || person.isLocal) return;
    const pub = participant.getTrackPublication(Track.Source.Microphone);
    if (pub?.track) pub.track.attach(audio);
    return () => {
      pub?.track?.detach(audio);
    };
  }, [participant, person.isLocal]);

  const initials = (person.name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  const showVideo = source === Track.Source.ScreenShare ? person.sharing : person.camOn;

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl bg-black/40 ring-1 ring-white/10',
        person.speaking && 'ring-2 ring-brand-400',
        className,
      )}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={person.isLocal}
        className={cn('size-full object-cover', !showVideo && 'hidden')}
      />
      {!person.isLocal && <audio ref={audioRef} autoPlay />}

      {!showVideo && (
        <div className="flex size-full items-center justify-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-white/10 text-lg font-semibold text-white/80">
            {initials}
          </span>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2.5 py-1.5">
        {person.micOn ? (
          <Mic className="size-3.5 shrink-0 text-white/80" aria-hidden="true" />
        ) : (
          <MicOff className="size-3.5 shrink-0 text-red-400" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-white">
          {person.name}
          {person.isLocal && ' •'}
        </span>
        {person.handUp && <Hand className="size-3.5 shrink-0 text-gold-400" aria-hidden="true" />}
        {person.sharing && source !== Track.Source.ScreenShare && (
          <MonitorUp className="size-3.5 shrink-0 text-brand-300" aria-hidden="true" />
        )}
        {person.isHost && (
          <span className="shrink-0 rounded bg-brand-500/90 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
            {t('host')}
          </span>
        )}
      </div>
    </div>
  );
}
