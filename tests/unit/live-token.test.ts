import { beforeAll, describe, expect, it } from 'vitest';
import type { mintRoomToken as MintRoomToken } from '@/lib/live/server';

/**
 * The token itself, signed by the real SDK.
 *
 * The grant tests prove the rules; this proves LiveKit's SDK will sign them.
 * It once would not: the host's grant named a source the SDK cannot write into
 * a token, `mintRoomToken` caught the throw and returned null, and every
 * teacher got « Impossible de joindre la salle » while every student got in.
 */

let mintRoomToken: typeof MintRoomToken;

beforeAll(async () => {
  process.env.LIVEKIT_URL = 'wss://livekit.test';
  process.env.LIVEKIT_API_KEY = 'test-key';
  process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-for-hs256';
  ({ mintRoomToken } = await import('@/lib/live/server'));
});

const ROOM_TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function claims(jwt: string) {
  const payload = jwt.split('.')[1]!;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    video: { canPublish?: boolean; canPublishSources?: string[]; roomAdmin?: boolean };
  };
}

describe('mintRoomToken', () => {
  it('signs the teacher’s token', async () => {
    const jwt = await mintRoomToken(ROOM_TOKEN, 'teacher', 'Enseignante', {
      isHost: true,
      muted: false,
      cameraAllowed: false,
      screenAllowed: false,
    });
    expect(jwt).not.toBeNull();
    const { video } = claims(jwt!);
    expect(video.roomAdmin).toBe(true);
    expect(video.canPublish).toBe(true);
    expect(video.canPublishSources ?? []).toEqual([]);
  });

  it('signs every student’s token', async () => {
    for (const muted of [false, true]) {
      for (const cameraAllowed of [false, true]) {
        for (const screenAllowed of [false, true]) {
          const jwt = await mintRoomToken(ROOM_TOKEN, 'student', 'Étudiant', {
            isHost: false,
            muted,
            cameraAllowed,
            screenAllowed,
          });
          expect(jwt).not.toBeNull();
          expect(claims(jwt!).video.roomAdmin ?? false).toBe(false);
        }
      }
    }
  });
});
