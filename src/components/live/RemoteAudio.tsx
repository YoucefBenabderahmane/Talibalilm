'use client';

import { useEffect, useRef } from 'react';
import { ParticipantEvent, Track, type Participant, type Room } from 'livekit-client';

/**
 * Everyone's voice, whether or not their camera is on.
 *
 * The microphone used to be attached inside `VideoTile` — and tiles only exist
 * for people in the video strip. A camera-off student, anyone past the twelfth
 * tile and the sharer had no audio element in the page at all, so the teacher
 * heard almost nothing. That is the whole reason a class sounded broken.
 *
 * One audio element per remote participant, mounted for as long as they are in
 * the room and independent of every video layout. The microphone and the
 * screen-share audio get their own elements: attaching two tracks to one
 * element replaces its stream rather than mixing them.
 */
export function RemoteAudio({ room }: { room: Room }) {
  return (
    <div className="sr-only" aria-hidden="true">
      {Array.from(room.remoteParticipants.values()).map((participant) => (
        <ParticipantAudio key={participant.identity} participant={participant} />
      ))}
    </div>
  );
}

function ParticipantAudio({ participant }: { participant: Participant }) {
  const mic = useRef<HTMLAudioElement | null>(null);
  const screen = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Captured here: the refs are stable for this effect's lifetime, and the
    // cleanup must detach from the elements it attached to.
    const micElement = mic.current;
    const screenElement = screen.current;

    const attach = (element: HTMLAudioElement | null, source: Track.Source) => {
      if (!element) return;
      const publication = participant.getTrackPublication(source);
      if (publication?.track) publication.track.attach(element);
    };

    const sync = () => {
      attach(micElement, Track.Source.Microphone);
      attach(screenElement, Track.Source.ScreenShareAudio);
    };

    sync();
    participant
      .on(ParticipantEvent.TrackSubscribed, sync)
      .on(ParticipantEvent.TrackUnsubscribed, sync)
      .on(ParticipantEvent.TrackMuted, sync)
      .on(ParticipantEvent.TrackUnmuted, sync);

    return () => {
      participant
        .off(ParticipantEvent.TrackSubscribed, sync)
        .off(ParticipantEvent.TrackUnsubscribed, sync)
        .off(ParticipantEvent.TrackMuted, sync)
        .off(ParticipantEvent.TrackUnmuted, sync);

      const micTrack = participant.getTrackPublication(Track.Source.Microphone)?.track;
      if (micTrack && micElement) micTrack.detach(micElement);
      const screenTrack = participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
      if (screenTrack && screenElement) screenTrack.detach(screenElement);
    };
  }, [participant]);

  return (
    <>
      <audio ref={mic} autoPlay />
      <audio ref={screen} autoPlay />
    </>
  );
}
