'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionState, RoomEvent, Track, type LocalTrackPublication, type Room } from 'livekit-client';
import { startTicker } from '@/lib/live/recording/ticker';
import { STAGE_BOX } from './useLiveDeck';

/**
 * The slide the class sees, streamed from the teacher's machine like Zoom.
 *
 * One canvas for the whole lesson — created once, never re-created by a React
 * render — because a captured stream belongs to the element it was taken from.
 * The page is drawn onto it, and the canvas is published as the room's
 * "slides" video track: its own source (`Unknown` in LiveKit), so it never
 * collides with a real screen share, which keeps working beside it.
 *
 * A still page costs almost nothing to stream: a frame is pushed when the page
 * changes, plus one a second so a student who joins late, or reconnects, gets
 * a keyframe at once. That clock runs in a worker, so a teacher who switches to
 * another window does not freeze the class's slide.
 *
 * The canvas is also what the teacher's own stage shows and what the recorder
 * draws: it is the page's own pixels, so nothing is ever unreadable.
 */

export const SLIDES_TRACK = 'slides';
const KEEPALIVE_FPS = 1;

export function useSlideBroadcast(room: Room, isHost: boolean) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const publicationRef = useRef<LocalTrackPublication | null>(null);
  const publishing = useRef<Promise<void> | null>(null);
  /** A page has been drawn: there is something worth publishing once connected. */
  const hasContent = useRef(false);
  /**
   * Our own copy of the frame on the canvas. The keepalive draws it again: a
   * canvas that has not changed may not hand the encoder a frame at all in a
   * background tab, and the page bitmap itself belongs to the deck's cache,
   * which may release it while it is still on screen.
   */
  const lastFrame = useRef<ImageBitmap | null>(null);
  const frameSeq = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const canvas = useCallback((): HTMLCanvasElement | null => {
    if (typeof document === 'undefined' || !isHost) return null;
    if (!canvasRef.current) {
      const element = document.createElement('canvas');
      element.width = STAGE_BOX.width;
      element.height = STAGE_BOX.height;
      // The recorder draws every element the stage marks; this one is ours.
      element.setAttribute('data-record', 'main');
      element.className = 'size-full object-contain select-none';
      canvasRef.current = element;
    }
    return canvasRef.current;
  }, [isHost]);

  const pushFrame = useCallback(() => {
    const track = trackRef.current as (MediaStreamTrack & { requestFrame?: () => void }) | null;
    track?.requestFrame?.();
  }, []);

  const publish = useCallback(async () => {
    const element = canvas();
    if (!element || publicationRef.current) return;
    if (room.state !== ConnectionState.Connected) return;
    publishing.current ??= (async () => {
      try {
        // captureStream(0): a frame only when asked for, so a still page is
        // not re-encoded thirty times a second.
        const track = element.captureStream(0).getVideoTracks()[0];
        if (!track) throw new Error('canvas.captureStream returned no video track');
        // Tells the encoder this is text: keep it sharp, drop frames before
        // dropping resolution.
        track.contentHint = 'text';
        trackRef.current = track;
        publicationRef.current = await room.localParticipant.publishTrack(track, {
          name: SLIDES_TRACK,
          source: Track.Source.Unknown,
          simulcast: false,
          degradationPreference: 'maintain-resolution',
          videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 5 },
        });
        setError(null);
        pushFrame();
      } catch (thrown) {
        trackRef.current?.stop();
        trackRef.current = null;
        publicationRef.current = null;
        setError(thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown));
      } finally {
        publishing.current = null;
      }
    })();
    await publishing.current;
  }, [canvas, pushFrame, room]);

  const unpublish = useCallback(() => {
    hasContent.current = false;
    frameSeq.current++;
    lastFrame.current?.close();
    lastFrame.current = null;
    const track = trackRef.current;
    const publication = publicationRef.current;
    publicationRef.current = null;
    trackRef.current = null;
    if (publication?.track) void room.localParticipant.unpublishTrack(publication.track, true).catch(() => {});
    track?.stop();
  }, [room]);

  /** Draw one page, letterboxed on black, and send it to the class. */
  const show = useCallback(
    async (bitmap: ImageBitmap) => {
      const element = canvas();
      const ctx = element?.getContext('2d');
      // A bitmap released by the cache between render and draw reads as 0×0:
      // refused before the canvas is touched, so the class keeps the last page
      // rather than a black one.
      if (!element || !ctx || !bitmap.width || !bitmap.height) return false;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, element.width, element.height);
      const fit = Math.min(element.width / bitmap.width, element.height / bitmap.height);
      const w = bitmap.width * fit;
      const h = bitmap.height * fit;
      try {
        ctx.drawImage(bitmap, (element.width - w) / 2, (element.height - h) / 2, w, h);
        hasContent.current = true;
      } catch {
        return false;
      }
      // The old copy goes now, not when the new one resolves: a keepalive tick
      // in between would otherwise paint the previous page back over this one.
      lastFrame.current?.close();
      lastFrame.current = null;
      const seq = ++frameSeq.current;
      void createImageBitmap(element)
        .then((copy) => {
          // Pages turned faster than the copies resolve: only the newest stays.
          if (seq !== frameSeq.current) {
            copy.close();
            return;
          }
          lastFrame.current?.close();
          lastFrame.current = copy;
        })
        .catch(() => {});
      await publish();
      pushFrame();
      return true;
    },
    [canvas, publish, pushFrame],
  );

  // The keepalive frame, from a clock a hidden tab does not throttle.
  useEffect(() => {
    if (!isHost) return;
    return startTicker(KEEPALIVE_FPS, () => {
      if (!publicationRef.current) return;
      const frame = lastFrame.current;
      const ctx = canvasRef.current?.getContext('2d');
      if (frame && ctx) {
        try {
          ctx.drawImage(frame, 0, 0);
        } catch {
          /* Replaced by a newer page in between; that page pushed its own frame. */
        }
      }
      pushFrame();
    });
  }, [isHost, pushFrame]);

  // A page shown while the room was still connecting goes up the moment it is
  // connected, instead of waiting for the next page turn.
  useEffect(() => {
    if (!isHost) return;
    const onState = (state: ConnectionState) => {
      if (state === ConnectionState.Connected && hasContent.current && !publicationRef.current) {
        void publish();
      }
    };
    room.on(RoomEvent.ConnectionStateChanged, onState);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onState);
    };
  }, [isHost, publish, room]);

  // A full reconnect drops our publications; the slide goes back up with the
  // next frame rather than leaving the class on a blank stage.
  useEffect(() => {
    if (!isHost) return;
    const onReconnected = () => {
      if (trackRef.current && !room.localParticipant.getTrackPublicationByName(SLIDES_TRACK)) {
        publicationRef.current = null;
        trackRef.current.stop();
        trackRef.current = null;
        void publish();
      }
    };
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => {
      room.off(RoomEvent.Reconnected, onReconnected);
    };
  }, [isHost, publish, room]);

  useEffect(() => () => unpublish(), [unpublish]);

  return { canvas, show, unpublish, error };
}
