import { describe, expect, it } from 'vitest';
import {
  corsProbeKey,
  deckKey,
  isDeckKey,
  isSlideKeyFor,
  safeFilename,
  slideKey,
  slideName,
  CORS_PROBE_KEY_PATTERN,
  DECK_KEY_PATTERN,
  SLIDE_KEY_PATTERN,
  VIDEO_KEY_PATTERN,
} from '@/lib/storage/key';

const SESSION = '11110000-0000-4000-8000-000000000001';
const OTHER = '11110000-0000-4000-8000-000000000002';
const FINGERPRINT = 'a'.repeat(64);

describe('slideKey', () => {
  it('files a slide under its own class', () => {
    expect(slideKey(SESSION, 'png', 'abcd1234efgh')).toBe(`live/${SESSION}/abcd1234efgh.png`);
  });

  it('produces a key the database constraint accepts', () => {
    // The CHECK in 20260912170000_live_slides.sql demands this exact shape; a
    // key that fails here would be refused on insert with no useful message.
    expect(SLIDE_KEY_PATTERN.test(slideKey(SESSION, 'png', slideName()))).toBe(true);
    expect(SLIDE_KEY_PATTERN.test(slideKey(SESSION, 'jpg', slideName()))).toBe(true);
    expect(SLIDE_KEY_PATTERN.test(slideKey(SESSION, 'webp', slideName()))).toBe(true);
  });

  it('names objects unpredictably', () => {
    const names = new Set(Array.from({ length: 50 }, () => slideName()));
    expect(names.size).toBe(50);
    expect(slideName()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('isSlideKeyFor', () => {
  it('accepts a key this session actually owns', () => {
    expect(isSlideKeyFor(`live/${SESSION}/abcd1234efgh.png`, SESSION)).toBe(true);
  });

  it('refuses another class’s object', () => {
    expect(isSlideKeyFor(`live/${OTHER}/abcd1234efgh.png`, SESSION)).toBe(false);
  });

  it('refuses an attempt to walk out of the prefix', () => {
    expect(isSlideKeyFor(`live/${SESSION}/../../secrets.png`, SESSION)).toBe(false);
    expect(isSlideKeyFor(`live/${SESSION}/..%2Fsecrets.png`, SESSION)).toBe(false);
    expect(isSlideKeyFor(`../live/${SESSION}/abcd1234efgh.png`, SESSION)).toBe(false);
  });

  it('refuses anything a browser would execute', () => {
    expect(isSlideKeyFor(`live/${SESSION}/payload12.html`, SESSION)).toBe(false);
    expect(isSlideKeyFor(`live/${SESSION}/payload12.svg`, SESSION)).toBe(false);
    expect(isSlideKeyFor(`live/${SESSION}/payload12.png.html`, SESSION)).toBe(false);
  });

  it('refuses a key for a session id that is not one', () => {
    expect(isSlideKeyFor('live/not-a-uuid/abcd1234efgh.png', 'not-a-uuid')).toBe(false);
  });
});

describe('shared deck keys', () => {
  it('files a page under the PDF fingerprint, not the session', () => {
    expect(deckKey(FINGERPRINT, 'webp', 'abcd1234efgh')).toBe(
      `decks/${FINGERPRINT}/abcd1234efgh.webp`,
    );
  });

  it('produces a key the database constraint accepts', () => {
    expect(DECK_KEY_PATTERN.test(deckKey(FINGERPRINT, 'png', slideName()))).toBe(true);
    expect(isDeckKey(deckKey(FINGERPRINT, 'jpg', slideName()))).toBe(true);
  });

  it('refuses a fingerprint that is not a sha-256, or a path trick', () => {
    expect(isDeckKey('decks/short/abcd1234efgh.png')).toBe(false);
    expect(isDeckKey(`decks/${FINGERPRINT}/../../secret.png`)).toBe(false);
    expect(isDeckKey(`decks/${FINGERPRINT}/payload.html`)).toBe(false);
    expect(isDeckKey(`live/${SESSION}/abcd1234efgh.png`)).toBe(false);
  });
});

describe('safeFilename', () => {
  it('keeps only the name the teacher would recognise', () => {
    expect(safeFilename('C:\\Users\\Youcef\\Desktop\\plan.png')).toBe('plan.png');
    expect(safeFilename('/etc/passwd')).toBe('passwd');
    expect(safeFilename('../../slide 1.png')).toBe('slide 1.png');
  });

  it('strips control characters and bounds the length', () => {
    expect(safeFilename('pl\u0000an\u001f.png')).toBe('plan.png');
    expect(safeFilename('a'.repeat(300)).length).toBe(120);
  });
});

/**
 * The diagnostics page writes a real object to prove a real upload works.
 *
 * That object must live somewhere no read path can ever reach. Every slide and
 * every video is fetched through a key that has been matched against one of the
 * two patterns above; if the probe's key could pass either, a future bug could
 * adopt it and serve eight bytes of test data to a student as a lesson.
 */
describe('the CORS probe key', () => {
  const key = corsProbeKey('0123456789abcdef0123456789abcdef');

  it('matches neither the slide nor the video pattern', () => {
    expect(SLIDE_KEY_PATTERN.test(key)).toBe(false);
    expect(VIDEO_KEY_PATTERN.test(key)).toBe(false);
  });

  it('is recognised as one of ours, and a key we did not mint is not', () => {
    expect(CORS_PROBE_KEY_PATTERN.test(key)).toBe(true);
    expect(CORS_PROBE_KEY_PATTERN.test('cors-probe/../../etc/passwd.bin')).toBe(false);
    expect(CORS_PROBE_KEY_PATTERN.test('lessons/a/b.mp4')).toBe(false);
  });
});
