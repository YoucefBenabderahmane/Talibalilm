'use client';

import { useTranslations } from 'next-intl';
import { Maximize2 } from 'lucide-react';
import { Track, type Room } from 'livekit-client';
import { VideoTile } from './VideoTile';
import type { RoomPerson } from './useRoom';

/**
 * The shared screen, reduced to the corner.
 *
 * Google Meet's rule, and the one the teacher asked for: presenting a slide
 * does not stop a share, it shrinks it. The shared screen keeps running in the
 * corner of the stage while the deck is read, and the expand button puts it
 * back on the stage, replacing the slide. Nothing is renegotiated with the
 * media server either way — only the layout moves.
 *
 * The expand control is the host's alone: whether the class watches the share
 * or the slide is one decision, and it is the teacher's.
 */
export function SharePip({
  room,
  person,
  canExpand,
  onExpand,
  localShare,
}: {
  room: Room;
  person: RoomPerson;
  /** The teacher's own screen as captured, before the server has confirmed it. */
  localShare?: Track | null;
  canExpand: boolean;
  onExpand: () => void;
}) {
  const t = useTranslations('live');
  const participant = person.isLocal
    ? room.localParticipant
    : room.remoteParticipants.get(person.identity);
  if (!participant) return null;

  return (
    <div className="absolute bottom-3 end-3 z-20 w-[min(38%,320px)] min-w-[128px] overflow-hidden rounded-xl shadow-lifted ring-1 ring-white/20">
      <VideoTile
        participant={participant}
        person={person}
        source={Track.Source.ScreenShare}
        track={person.isLocal ? localShare : undefined}
        record="pip"
        className="aspect-video w-full rounded-xl ring-0"
      />
      {canExpand && (
        <button
          type="button"
          onClick={onExpand}
          title={t('shareExpand')}
          className="absolute end-1.5 top-1.5 rounded-lg bg-black/60 p-1.5 text-white/80 transition-colors hover:bg-black/80 hover:text-white"
        >
          <Maximize2 className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{t('shareExpand')}</span>
        </button>
      )}
    </div>
  );
}
