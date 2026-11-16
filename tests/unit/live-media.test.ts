import { describe, expect, it, vi } from 'vitest';
import { Track, type Room } from 'livekit-client';
import {
  roomOptions,
  SCREEN_CAPTURE,
  startScreenShare,
  type CaptureStamps,
} from '@/lib/live/media';

describe('the room’s media settings', () => {
  it('are the ones the room has always used', () => {
    // A lighter share encoding was measured and not kept: these must not drift
    // without a measurement behind the change.
    const options = roomOptions();
    expect(options.adaptiveStream).toBe(true);
    expect(options.dynacast).toBe(true);
    expect(options.videoCaptureDefaults?.resolution).toMatchObject({ width: 1280, height: 720 });
    expect(options.publishDefaults).toEqual({ simulcast: true });
    expect(SCREEN_CAPTURE).toEqual({ audio: true });
  });
});

/** A captured track, as far as startScreenShare looks at it. */
function fakeTrack(kind: Track.Kind) {
  const media = { readyState: 'live' as 'live' | 'ended' };
  return {
    kind,
    mediaStreamTrack: media,
    stop: vi.fn(() => {
      media.readyState = 'ended';
    }),
  };
}

function fakeRoom(publish: () => Promise<unknown>) {
  const video = fakeTrack(Track.Kind.Video);
  const audio = fakeTrack(Track.Kind.Audio);
  const local = {
    createScreenTracks: vi.fn(async () => [video, audio]),
    publishTrack: vi.fn(publish),
    unpublishTrack: vi.fn(async () => undefined),
  };
  return { room: { localParticipant: local } as unknown as Room, local, video, audio };
}

describe('startScreenShare', () => {
  it('shows her screen before the server has confirmed the publish', async () => {
    let confirm!: () => void;
    const confirmed = new Promise<void>((resolve) => (confirm = resolve));
    const { room, video } = fakeRoom(() => confirmed);
    const seen = vi.fn();

    const started = startScreenShare(room, seen);
    await vi.waitFor(() => expect(seen).toHaveBeenCalled());
    expect(seen.mock.calls[0]?.[0]).toBe(video);

    confirm();
    await expect(started).resolves.toBeUndefined();
  });

  it('stamps when Chrome is asked and when it answers', async () => {
    const { room } = fakeRoom(async () => ({}));
    const stamps: CaptureStamps = { requested: null, chosen: null };
    await startScreenShare(room, () => {}, stamps);
    expect(stamps.requested).not.toBeNull();
    expect(stamps.chosen).not.toBeNull();
    expect(stamps.chosen!).toBeGreaterThanOrEqual(stamps.requested!);
  });

  it('asks for the screen and its sound exactly as setScreenShareEnabled did', async () => {
    const { room, local } = fakeRoom(async () => ({}));
    await startScreenShare(room, () => {});
    expect(local.createScreenTracks).toHaveBeenCalledWith({ audio: true });
    // Published with the room's defaults, like setScreenShareEnabled does.
    expect(local.publishTrack).toHaveBeenCalledTimes(2);
    for (const call of local.publishTrack.mock.calls) expect(call).toHaveLength(1);
  });

  it('leaves nothing captured when the publish is refused', async () => {
    const { room, local, video, audio } = fakeRoom(async () => {
      throw new Error('publish refused');
    });
    await expect(startScreenShare(room, () => {})).rejects.toThrow('publish refused');
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(local.unpublishTrack).toHaveBeenCalledTimes(2);
  });

  it('withdraws a share that was stopped while it was being published', async () => {
    let confirm!: () => void;
    const confirmed = new Promise<void>((resolve) => (confirm = resolve));
    const { room, local, video, audio } = fakeRoom(() => confirmed);

    const started = startScreenShare(room, () => {});
    await vi.waitFor(() => expect(local.publishTrack).toHaveBeenCalled());
    video.stop(); // « Arrêter » before the server answered
    confirm();

    await expect(started).rejects.toThrow('stopped before it was published');
    expect(local.unpublishTrack).toHaveBeenCalledTimes(2);
    expect(audio.stop).toHaveBeenCalled();
  });

  it('passes the refusal on when she cancels the picker', async () => {
    const { room, local } = fakeRoom(async () => ({}));
    local.createScreenTracks.mockRejectedValueOnce(
      new DOMException('Permission denied', 'NotAllowedError'),
    );
    const seen = vi.fn();
    await expect(startScreenShare(room, seen)).rejects.toThrow('Permission denied');
    expect(seen).not.toHaveBeenCalled();
    expect(local.publishTrack).not.toHaveBeenCalled();
  });
});
