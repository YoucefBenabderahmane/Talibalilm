import { describe, expect, it } from 'vitest';
import { newlyAllowed } from '../../src/lib/live/abilities';

/**
 * What an approval starts.
 *
 * The teacher's decision arrives as a LiveKit permission change, and the room
 * acts on the EDGE — the moment a permission is granted. Getting the edge wrong
 * means either a class that does not hear the student the teacher just allowed,
 * or a student unmuted without asking.
 */
describe('a permission change', () => {
  const none = { mic: false, camera: false, screen: false };

  it('starts nothing on the first answer — joining a room is not an approval', () => {
    expect(newlyAllowed(null, { mic: true, camera: true, screen: true })).toEqual({
      mic: false,
      camera: false,
    });
  });

  it('starts the microphone and camera the teacher just allowed', () => {
    expect(newlyAllowed(none, { ...none, mic: true })).toEqual({ mic: true, camera: false });
    expect(newlyAllowed(none, { ...none, camera: true })).toEqual({ mic: false, camera: true });
    expect(newlyAllowed(none, { ...none, mic: true, camera: true })).toEqual({
      mic: true,
      camera: true,
    });
  });

  it('starts nothing again while the permission is already held', () => {
    const allowed = { mic: true, camera: true, screen: false };
    expect(newlyAllowed(allowed, { ...allowed })).toEqual({ mic: false, camera: false });
  });

  it('starts nothing on a revocation — the media server already cut the track', () => {
    const allowed = { mic: true, camera: true, screen: false };
    expect(newlyAllowed(allowed, none)).toEqual({ mic: false, camera: false });
  });

  it('does not treat a screen-share change as a microphone or camera grant', () => {
    expect(newlyAllowed(none, { ...none, screen: true })).toEqual({ mic: false, camera: false });
  });
});
