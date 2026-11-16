'use client';

import { useEffect, type RefObject } from 'react';
import { type Participant, type Track, type TrackPublication } from 'livekit-client';

/**
 * Keep one participant's track attached to one `<video>`.
 *
 * Attached imperatively because a `MediaStreamTrack` is not React state:
 * re-rendering must not detach and reattach it, which is a black flash every
 * time somebody else raises a hand. The interval is a cheap resync for a track
 * that arrives after the element is mounted — a camera approved mid-lesson, or
 * a publication renegotiated on reconnect.
 */
export function useAttachedTrack(
  participant: Participant,
  source: Track.Source,
  videoRef: RefObject<HTMLVideoElement | null>,
  /**
   * Shown until the publication has a track: the teacher's own screen, as
   * captured, while the server has not yet confirmed the share.
   */
  fallback?: Track | null,
): void {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const attach = () => {
      const pub: TrackPublication | undefined = participant.getTrackPublication(source);
      const track = pub?.track ?? fallback;
      if (track) track.attach(video);
    };
    attach();

    const id = window.setInterval(attach, 1000);
    return () => {
      window.clearInterval(id);
      const pub = participant.getTrackPublication(source);
      pub?.track?.detach(video);
      fallback?.detach(video);
    };
  }, [participant, source, videoRef, fallback]);
}
