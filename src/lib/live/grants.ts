/**
 * What one person may do inside a classroom, as LiveKit understands it.
 *
 * This is the security boundary of the room, so it is a pure function with
 * tests rather than an object built inline next to the token call.
 *
 * The important idea: these are not hints to the browser. LiveKit stamps them
 * into a signed token, and the media server enforces them. A student whose
 * grant carries no camera source cannot publish a camera — not because the
 * button is hidden, but because the SFU refuses the track. Hiding the button
 * is what we do so the page is not confusing; this is what makes it true.
 *
 * That distinction is the whole reason the room is being rebuilt. On the
 * embedded classroom every participant arrived with identical powers and the
 * teacher joined their own class as a student, because the public server would
 * not mint a token that said otherwise. Here we mint it ourselves.
 */

/**
 * `slides` is the teacher's live deck: a page drawn on her machine and streamed
 * as its own track (LiveKit's `Unknown` source), so it never takes the place of
 * a real screen share. Granted to the host only.
 */
export type TrackSource = 'camera' | 'microphone' | 'screen_share' | 'screen_share_audio' | 'slides';

export interface RoomPermissions {
  /** Staff. Publishes freely, and holds the controls over everyone else. */
  isHost: boolean;
  /** The host has silenced this participant. Survives a reload — it is a column. */
  muted: boolean;
  /** Camera allowed, either because the room lets everyone or because they were asked. */
  cameraAllowed: boolean;
  screenAllowed: boolean;
}

export interface RoomGrant {
  roomJoin: true;
  room: string;
  canSubscribe: true;
  canPublish: boolean;
  canPublishData: boolean;
  canPublishSources: TrackSource[];
  /** Never granted to a student. Room admin can mute and remove anyone. */
  roomAdmin: boolean;
}

/**
 * The grant for one person in one room.
 *
 * A student always keeps `canSubscribe` — they came to watch the lesson — and
 * `canPublishData` so they can use the chat, which the database polices
 * separately by refusing a muted student's insert.
 *
 * What they do not get is a source list beyond what the teacher has allowed,
 * and never `roomAdmin`. Mute is the absence of a microphone source rather
 * than a flag asking politely: an unmuted student can be heard, a muted one
 * has nothing the server will accept.
 */
export function roomGrant(room: string, p: RoomPermissions): RoomGrant {
  if (p.isHost) {
    return {
      roomJoin: true,
      room,
      canSubscribe: true,
      canPublish: true,
      canPublishData: true,
      canPublishSources: ['camera', 'microphone', 'screen_share', 'screen_share_audio', 'slides'],
      roomAdmin: true,
    };
  }

  const sources: TrackSource[] = [];
  if (!p.muted) sources.push('microphone');
  if (p.cameraAllowed && !p.muted) sources.push('camera');
  if (p.screenAllowed) sources.push('screen_share', 'screen_share_audio');

  return {
    roomJoin: true,
    room,
    canSubscribe: true,
    // With no source at all there is nothing to publish; saying so plainly
    // stops the client from even trying and showing a device prompt.
    canPublish: sources.length > 0,
    canPublishData: true,
    canPublishSources: sources,
    roomAdmin: false,
  };
}

/** The LiveKit room name for a class. Derived from the room token, never from client input. */
export function liveKitRoom(roomToken: string): string {
  return `class-${roomToken}`;
}
