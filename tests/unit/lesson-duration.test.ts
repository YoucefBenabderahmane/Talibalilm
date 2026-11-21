import { describe, expect, it } from 'vitest';
import { lessonMinutes, MAX_LESSON_SECONDS, videoSeconds } from '@/lib/content/duration';

describe('videoSeconds', () => {
  it('keeps a real length, in whole seconds', () => {
    expect(videoSeconds(1199.6)).toBe(1200);
    expect(videoSeconds(20.04)).toBe(20);
    expect(videoSeconds(0.6)).toBe(1);
    expect(videoSeconds(MAX_LESSON_SECONDS)).toBe(86_400);
  });

  it('gives nothing when the video does not really say', () => {
    // A recording straight from the browser, before it is indexed.
    expect(videoSeconds(Infinity)).toBeNull();
    // A file the browser could not read.
    expect(videoSeconds(Number.NaN)).toBeNull();
    expect(videoSeconds(0)).toBeNull();
    expect(videoSeconds(0.4)).toBeNull();
    expect(videoSeconds(-5)).toBeNull();
    expect(videoSeconds(null)).toBeNull();
    expect(videoSeconds(undefined)).toBeNull();
  });

  it('refuses more than a day, which the column would refuse too', () => {
    expect(videoSeconds(MAX_LESSON_SECONDS + 1)).toBeNull();
  });
});

describe('lessonMinutes', () => {
  it('shows nothing for a lesson nobody has given a length', () => {
    expect(lessonMinutes(0)).toBeNull();
    expect(lessonMinutes(-60)).toBeNull();
    expect(lessonMinutes(null)).toBeNull();
    expect(lessonMinutes(undefined)).toBeNull();
    expect(lessonMinutes(Number.NaN)).toBeNull();
  });

  it('never shows « 0 min » for a known length', () => {
    expect(lessonMinutes(20)).toBe(1);
    expect(lessonMinutes(89)).toBe(1);
  });

  it('rounds to the nearest minute', () => {
    expect(lessonMinutes(90)).toBe(2);
    expect(lessonMinutes(1200)).toBe(20);
    expect(lessonMinutes(5400)).toBe(90);
    expect(lessonMinutes(MAX_LESSON_SECONDS)).toBe(1440);
  });
});
