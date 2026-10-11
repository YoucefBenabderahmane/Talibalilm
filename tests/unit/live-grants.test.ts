import { describe, expect, it } from 'vitest';
import { liveKitRoom, roomGrant } from '@/lib/live/grants';

const ROOM = liveKitRoom('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
const student = { isHost: false, muted: false, cameraAllowed: false, screenAllowed: false };

describe('roomGrant — the host', () => {
  it('may publish everything and administer the room', () => {
    const g = roomGrant(ROOM, { ...student, isHost: true });
    expect(g.roomAdmin).toBe(true);
    expect(g.canPublishSources).toContain('camera');
    expect(g.canPublishSources).toContain('screen_share');
  });

  it('may stream the live deck, as its own track beside a screen share', () => {
    expect(roomGrant(ROOM, { ...student, isHost: true }).canPublishSources).toContain('slides');
  });

  it('keeps its powers even if the room muted them', () => {
    // A teacher muted by an earlier state must not lock themselves out of
    // their own class; host powers come from the role, not from a column.
    const g = roomGrant(ROOM, {
      isHost: true,
      muted: true,
      cameraAllowed: false,
      screenAllowed: false,
    });
    expect(g.roomAdmin).toBe(true);
    expect(g.canPublishSources).toContain('microphone');
  });
});

describe('roomGrant — a student', () => {
  it('is never a room admin', () => {
    // The single most important assertion here. roomAdmin would let them mute
    // and remove anyone, including the teacher.
    expect(roomGrant(ROOM, student).roomAdmin).toBe(false);
    expect(
      roomGrant(ROOM, { ...student, cameraAllowed: true, screenAllowed: true }).roomAdmin,
    ).toBe(false);
  });

  it('may speak and watch by default, but not show a camera', () => {
    const g = roomGrant(ROOM, student);
    expect(g.canSubscribe).toBe(true);
    expect(g.canPublishSources).toEqual(['microphone']);
    expect(g.canPublishSources).not.toContain('camera');
  });

  it('gets a camera only once the teacher allows it', () => {
    const g = roomGrant(ROOM, { ...student, cameraAllowed: true });
    expect(g.canPublishSources).toContain('camera');
  });

  it('gets a screen only once the teacher allows it', () => {
    expect(roomGrant(ROOM, student).canPublishSources).not.toContain('screen_share');
    expect(roomGrant(ROOM, { ...student, screenAllowed: true }).canPublishSources).toContain(
      'screen_share',
    );
  });

  it('has nothing to publish once muted — not a flag, an empty list', () => {
    // Mute is the absence of a microphone the server will accept, so it cannot
    // be undone by anything the browser decides to do.
    const g = roomGrant(ROOM, { ...student, muted: true, cameraAllowed: true });
    expect(g.canPublishSources).toEqual([]);
    expect(g.canPublish).toBe(false);
    expect(g.canPublishSources).not.toContain('microphone');
    expect(g.canPublishSources).not.toContain('camera');
  });

  it('can still watch and use the chat while muted', () => {
    // Muting silences someone; it does not throw them out of the lesson.
    const g = roomGrant(ROOM, { ...student, muted: true });
    expect(g.canSubscribe).toBe(true);
    expect(g.canPublishData).toBe(true);
  });

  it('is scoped to one room and never a wildcard', () => {
    const g = roomGrant(ROOM, student);
    expect(g.room).toBe(ROOM);
    expect(g.room).not.toContain('*');
  });
});

describe('roomGrant — the live deck is the teacher’s alone', () => {
  it('is never granted to a student, whatever else they are allowed', () => {
    for (const p of [
      student,
      { ...student, cameraAllowed: true },
      { ...student, screenAllowed: true },
      { ...student, cameraAllowed: true, screenAllowed: true },
    ]) {
      expect(roomGrant(ROOM, p).canPublishSources).not.toContain('slides');
    }
  });
});
