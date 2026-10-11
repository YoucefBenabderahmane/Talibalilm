import { describe, expect, it } from 'vitest';
import {
  acceptFrom,
  decodeMessage,
  encodeMessage,
  participantIsHost,
  type BoardOp,
  type RoomMessage,
} from '@/lib/live/protocol';

const round = (m: RoomMessage) => decodeMessage(encodeMessage(m));

describe('acceptFrom — what a student may not announce', () => {
  it('drops a student pretending to drive the slides or the board', () => {
    // A student's token permits data messages, because they need the chat. So
    // this refusal cannot live in the token; it lives on every receiver.
    for (const m of [
      { t: 'slide', i: 3 },
      { t: 'board', op: { t: 'stroke', pts: [0, 0, 1, 1], color: '#000', w: 2 } },
      { t: 'board-clear' },
      { t: 'rec', on: true },
      { t: 'deck' },
      { t: 'focus', tab: 'board', boardOnStage: true },
      { t: 'ended' },
    ] as RoomMessage[]) {
      expect(acceptFrom(m, false)).toBe(false);
      expect(acceptFrom(m, true)).toBe(true);
    }
  });

  it('lets anyone chat, raise a hand, ask for a camera, or ask where the lesson is', () => {
    for (const m of [
      { t: 'chat', body: 'bonjour' },
      { t: 'hand', up: true },
      { t: 'ask', what: 'camera' },
      { t: 'sync' },
    ] as RoomMessage[]) {
      expect(acceptFrom(m, false)).toBe(true);
    }
  });
});

describe('decodeMessage — everything on the wire is another browser’s word', () => {
  it('round-trips what the room actually sends', () => {
    expect(round({ t: 'chat', body: 'salam' })).toEqual({ t: 'chat', body: 'salam' });
    expect(round({ t: 'hand', up: true })).toEqual({ t: 'hand', up: true });
    expect(round({ t: 'slide', i: 4 })).toEqual({ t: 'slide', i: 4 });
    expect(round({ t: 'slide', i: 7, live: true })).toEqual({ t: 'slide', i: 7, live: true });
    expect(round({ t: 'deck' })).toEqual({ t: 'deck' });
    expect(round({ t: 'sync' })).toEqual({ t: 'sync' });
    expect(round({ t: 'focus', tab: 'board', boardOnStage: true })).toEqual({
      t: 'focus',
      tab: 'board',
      boardOnStage: true,
    });
    expect(round({ t: 'focus', tab: 'chat' })).toEqual({ t: 'focus', tab: 'chat' });
    expect(round({ t: 'focus', tab: 'slides', sharePip: true })).toEqual({
      t: 'focus',
      tab: 'slides',
      sharePip: true,
    });
    expect(round({ t: 'focus', tab: 'slides', sharePip: false })).toEqual({
      t: 'focus',
      tab: 'slides',
      sharePip: false,
    });
    expect(round({ t: 'ended' })).toEqual({ t: 'ended' });
  });

  it('round-trips the eraser as a stroke that erases', () => {
    const op: BoardOp = { t: 'stroke', pts: [0, 0, 1, 1], color: '#000', w: 24, erase: true };
    expect(round({ t: 'board', op })).toEqual({ t: 'board', op });
  });

  it('drops malformed or unknown payloads rather than throwing', () => {
    // One peer sending nonsense must not take the classroom down for everyone.
    expect(decodeMessage(new TextEncoder().encode('not json'))).toBeNull();
    expect(decodeMessage(new TextEncoder().encode('{"t":"dropTable"}'))).toBeNull();
    expect(decodeMessage(new TextEncoder().encode('null'))).toBeNull();
    expect(decodeMessage(new TextEncoder().encode('{"nope":1}'))).toBeNull();
  });

  it('refuses an empty or oversized chat line', () => {
    expect(decodeMessage(encodeMessage({ t: 'chat', body: '   ' }))).toBeNull();
    expect(decodeMessage(encodeMessage({ t: 'chat', body: 'x'.repeat(2001) }))).toBeNull();
  });

  it('refuses a payload too big to be one mark on a board', () => {
    const huge = {
      t: 'board',
      op: { t: 'stroke', pts: Array(50000).fill(1), color: '#000', w: 1 },
    };
    expect(decodeMessage(encodeMessage(huge as RoomMessage))).toBeNull();
  });

  it('refuses a board op that is not one', () => {
    expect(
      decodeMessage(encodeMessage({ t: 'board', op: { t: 'stroke' } } as unknown as RoomMessage)),
    ).toBeNull();
    expect(
      decodeMessage(encodeMessage({ t: 'board', op: { t: 'evil' } } as unknown as RoomMessage)),
    ).toBeNull();
    // The eraser flag is a boolean or absent — a truthy string is not one.
    expect(
      decodeMessage(
        encodeMessage({
          t: 'board',
          op: { t: 'stroke', pts: [0, 0], color: '#000', w: 1, erase: 'yes' },
        } as unknown as RoomMessage),
      ),
    ).toBeNull();
  });

  it('refuses a focus message naming a tab that does not exist', () => {
    expect(
      decodeMessage(encodeMessage({ t: 'focus', tab: 'secrets' } as unknown as RoomMessage)),
    ).toBeNull();
    expect(
      decodeMessage(
        encodeMessage({ t: 'focus', tab: 'board', boardOnStage: 'yes' } as unknown as RoomMessage),
      ),
    ).toBeNull();
    expect(
      decodeMessage(
        encodeMessage({ t: 'focus', tab: 'slides', sharePip: 'yes' } as unknown as RoomMessage),
      ),
    ).toBeNull();
  });

  it('refuses a slide index that is not a sane number', () => {
    for (const i of [-1, 1.5, NaN, 100000]) {
      expect(decodeMessage(encodeMessage({ t: 'slide', i } as RoomMessage))).toBeNull();
    }
  });
});

describe('participantIsHost', () => {
  it('reads the role our server signed into the token', () => {
    expect(participantIsHost('{"role":"host"}')).toBe(true);
    expect(participantIsHost('{"role":"participant"}')).toBe(false);
  });

  it('treats anything unsigned, absent or malformed as not the teacher', () => {
    expect(participantIsHost(undefined)).toBe(false);
    expect(participantIsHost('')).toBe(false);
    expect(participantIsHost('host')).toBe(false);
    expect(participantIsHost('{"role":')).toBe(false);
  });
});

describe('the live deck flag', () => {
  it('counts only a literal true, so a malformed flag falls back to the uploaded deck', () => {
    for (const live of ['true', 1, {}, null]) {
      const raw = new TextEncoder().encode(JSON.stringify({ t: 'slide', i: 2, live }));
      expect(decodeMessage(raw)).toEqual({ t: 'slide', i: 2 });
    }
  });

  it('stays a teacher-only message', () => {
    expect(acceptFrom({ t: 'slide', i: 1, live: true }, false)).toBe(false);
    expect(acceptFrom({ t: 'slide', i: 1, live: true }, true)).toBe(true);
  });
});
