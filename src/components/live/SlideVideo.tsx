'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { RoomEvent, type RemoteVideoTrack, type Room } from 'livekit-client';
import { SLIDES_TRACK } from './useSlideBroadcast';

/**
 * The teacher's live slide, as the class receives it.
 *
 * The page was drawn on the teacher's machine and arrives as her "slides" video
 * track — the way Zoom shows a presenter's document. Nothing is downloaded and
 * nothing expires; a student who joins late gets the current page with the
 * next keyframe, about a second.
 */
export function SlideVideo({ room, hostIdentity }: { room: Room; hostIdentity: string | null }) {
  const video = useRef<HTMLVideoElement>(null);
  const [track, setTrack] = useState<RemoteVideoTrack | null>(null);

  useEffect(() => {
    const resolve = () => {
      const host = hostIdentity ? room.remoteParticipants.get(hostIdentity) : undefined;
      const publication = host?.getTrackPublicationByName(SLIDES_TRACK);
      setTrack((publication?.track as RemoteVideoTrack | undefined) ?? null);
    };
    resolve();
    room
      .on(RoomEvent.TrackSubscribed, resolve)
      .on(RoomEvent.TrackUnsubscribed, resolve)
      .on(RoomEvent.TrackPublished, resolve)
      .on(RoomEvent.TrackUnpublished, resolve)
      .on(RoomEvent.ParticipantConnected, resolve)
      .on(RoomEvent.ParticipantDisconnected, resolve);
    return () => {
      room
        .off(RoomEvent.TrackSubscribed, resolve)
        .off(RoomEvent.TrackUnsubscribed, resolve)
        .off(RoomEvent.TrackPublished, resolve)
        .off(RoomEvent.TrackUnpublished, resolve)
        .off(RoomEvent.ParticipantConnected, resolve)
        .off(RoomEvent.ParticipantDisconnected, resolve);
    };
  }, [room, hostIdentity]);

  useEffect(() => {
    const element = video.current;
    if (!track || !element) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  return (
    <div className="relative flex size-full items-center justify-center">
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        className="size-full object-contain select-none"
      />
      {!track && (
        <Loader2
          className="absolute size-6 animate-spin text-white/40"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
