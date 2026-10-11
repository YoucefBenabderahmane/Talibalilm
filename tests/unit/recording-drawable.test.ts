import { describe, expect, it } from 'vitest';
import { drawDecision } from '@/lib/live/recording/drawable';

/**
 * What the recorder may draw. One wrong "draw" here taints the recording
 * canvas and freezes the file for the rest of the class — the browser test
 * `tests/browser/recorder.spec.ts` proves that end to end; these pin the rule.
 */
const PAGE = 'https://www.talibalim.com';
const R2 = 'https://bucket.abc123.r2.cloudflarestorage.com/slides/a.webp?X-Amz-Signature=x';

describe('drawDecision', () => {
  it('draws the room’s own video and whiteboard', () => {
    expect(drawDecision({ kind: 'video', ready: true }, PAGE)).toBe('draw');
    expect(drawDecision({ kind: 'canvas', ready: true }, PAGE)).toBe('draw');
  });

  it('refuses an R2 slide loaded without CORS — the October freeze', () => {
    expect(drawDecision({ kind: 'image', src: R2, crossOrigin: null, ready: true }, PAGE)).toBe(
      'foreign',
    );
  });

  it('draws the same slide once it was loaded through CORS', () => {
    expect(
      drawDecision({ kind: 'image', src: R2, crossOrigin: 'anonymous', ready: true }, PAGE),
    ).toBe('draw');
  });

  it('draws same-origin, data: and blob: images', () => {
    for (const src of [
      `${PAGE}/branding/logo.png`,
      '/relative/slide.png',
      'data:image/png;base64,AAAA',
      'blob:https://www.talibalim.com/123',
    ]) {
      expect(drawDecision({ kind: 'image', src, crossOrigin: null, ready: true }, PAGE), src).toBe(
        'draw',
      );
    }
  });

  it('treats the apex and www as different origins, as the browser does', () => {
    expect(
      drawDecision(
        { kind: 'image', src: 'https://talibalim.com/a.png', crossOrigin: null, ready: true },
        PAGE,
      ),
    ).toBe('foreign');
  });

  it('waits for anything not ready yet', () => {
    expect(drawDecision({ kind: 'image', src: R2, crossOrigin: 'anonymous', ready: false }, PAGE)).toBe(
      'not-ready',
    );
    expect(drawDecision({ kind: 'video', ready: false }, PAGE)).toBe('not-ready');
  });

  it('refuses a URL it cannot parse rather than guessing', () => {
    expect(
      drawDecision({ kind: 'image', src: 'http://[bad', crossOrigin: null, ready: true }, PAGE),
    ).toBe('foreign');
  });
});
