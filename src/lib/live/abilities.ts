/**
 * What the media server currently accepts from this viewer, and what a change
 * to it means.
 *
 * In a module of its own so the transition rule can be tested without a room, a
 * browser or LiveKit — the same reason `zoom.ts` exists.
 */
export interface RoomAbilities {
  mic: boolean;
  camera: boolean;
  screen: boolean;
}

/**
 * Which publishing permissions just arrived.
 *
 * The teacher's approval reaches LiveKit as a permission change. Comparing the
 * previous answer with the new one is what makes it possible to act on the
 * TRANSITION: a student who joins a room where mics are already open must not
 * be unmuted by their own page, and a host's permissions never transition.
 */
export function newlyAllowed(
  previous: RoomAbilities | null,
  next: RoomAbilities | null,
): { mic: boolean; camera: boolean } {
  if (!previous || !next) return { mic: false, camera: false };
  return { mic: !previous.mic && next.mic, camera: !previous.camera && next.camera };
}
