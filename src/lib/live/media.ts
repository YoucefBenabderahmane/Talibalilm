import {
  Track,
  VideoPresets,
  type LocalTrack,
  type LocalVideoTrack,
  type Room,
  type RoomOptions,
  type ScreenShareCaptureOptions,
} from 'livekit-client';

/**
 * What the teacher's browser sends, and how a screen share starts.
 *
 * The settings are the room's as they have always been: LiveKit's defaults
 * for the share, a 720p camera, simulcast. A lighter share encoding was tried
 * and measured against a real LiveKit server; it was not a clear gain (on a
 * thin upload its first picture took longer), so it was not kept.
 */

export function roomOptions(): RoomOptions {
  return {
    // The lesson is watched on phone screens as often as on a laptop, so the
    // server sends each viewer a layer it can actually take. 720p is the
    // camera's capture ceiling.
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    publishDefaults: { simulcast: true },
  };
}

/** What `setScreenShareEnabled(true, { audio: true })` captured: the screen and its sound. */
export const SCREEN_CAPTURE: ScreenShareCaptureOptions = { audio: true };

/** When the room asked Chrome for its picker, and when Chrome answered. */
export interface CaptureStamps {
  requested: number | null;
  chosen: number | null;
}

/**
 * Start a screen share, showing it to the teacher the moment she picks it.
 *
 * `setScreenShareEnabled` resolves only once the server has confirmed the
 * publish, and her own stage stayed empty until then. Here the captured track
 * is handed to `onCaptured` first, and published after, the same way
 * `setScreenShareEnabled` publishes it (`publishDefaults`).
 *
 * `stamps` receives the moment Chrome is asked for its picker and the moment
 * it answers (see lib/live/share-timeline.ts).
 *
 * Rejects when she cancels the picker or the browser refuses, like
 * `setScreenShareEnabled` does.
 */
export async function startScreenShare(
  room: Room,
  onCaptured: (video: LocalVideoTrack, tracks: readonly LocalTrack[]) => void,
  stamps: CaptureStamps = { requested: null, chosen: null },
): Promise<void> {
  // createScreenTracks calls getDisplayMedia before its first await, so this
  // is the moment Chrome is asked.
  stamps.requested = performance.now();
  const tracks: LocalTrack[] = await room.localParticipant.createScreenTracks(SCREEN_CAPTURE);
  stamps.chosen = performance.now();
  const video = tracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
  if (video) onCaptured(video, tracks);
  const withdraw = async () => {
    for (const track of tracks) {
      await room.localParticipant.unpublishTrack(track, true).catch(() => {});
      track.stop();
    }
  };
  try {
    await Promise.all(tracks.map((track) => room.localParticipant.publishTrack(track)));
  } catch (error) {
    // Nothing half-published: a refused publish must not leave the screen
    // captured, with the browser's sharing banner up and nobody receiving it.
    await withdraw();
    throw error;
  }
  // Stopped while the publish was on its way (her « Arrêter », or the
  // browser's own « Arrêter le partage »): the class must not be left on a
  // share that has already ended.
  if (tracks.some((t) => t.mediaStreamTrack.readyState === 'ended')) {
    await withdraw();
    // Her own choice, like closing the picker: reported as a cancel, not a failure.
    throw new DOMException('Share cancelled: stopped before it was published', 'AbortError');
  }
}
