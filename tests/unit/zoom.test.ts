import { describe, expect, it } from 'vitest';
import { clampPan, MAX_ZOOM, MIN_ZOOM, nextZoom } from '../../src/lib/live/zoom';

/**
 * The slide zoom, as arithmetic. A teacher reading a dense PDF must be able to
 * push in until the text is legible and pull back out to the fitted page, and
 * a pan must never leave the slide somewhere it cannot be brought back from.
 */
describe('the slide zoom', () => {
  it('zooms in when the wheel goes up and out when it goes down', () => {
    expect(nextZoom(1, -100)).toBeGreaterThan(1);
    expect(nextZoom(2, 100)).toBeLessThan(2);
  });

  it('never goes below the fitted page or past the ceiling', () => {
    expect(nextZoom(1, 5000)).toBe(MIN_ZOOM);
    expect(nextZoom(MAX_ZOOM, -5000)).toBe(MAX_ZOOM);
    // A small wheel tick at the ceiling still lands on the ceiling, not above.
    expect(nextZoom(MAX_ZOOM, -1)).toBe(MAX_ZOOM);
  });

  it('is proportional, so a trackpad and a wheel feel the same', () => {
    // Two small ticks move less than one big one, and the factor is the same
    // wherever the zoom starts.
    const oneBig = nextZoom(1, -100) - 1;
    const twoSmall = nextZoom(nextZoom(1, -50), -50) - 1;
    expect(twoSmall).toBeCloseTo(oneBig, 2);
    expect(nextZoom(2, -50) / 2).toBeCloseTo(nextZoom(1, -50), 3);
  });
});

describe('panning a zoomed slide', () => {
  it('cannot move at all at the fitted size', () => {
    expect(clampPan({ x: 120, y: -80 }, 1, 800, 600)).toEqual({ x: 0, y: 0 });
  });

  it('bounds the slide by what the zoom added, not by the container', () => {
    // At 2× there is half a container of slack in each direction.
    expect(clampPan({ x: 9999, y: -9999 }, 2, 800, 600)).toEqual({ x: 400, y: -300 });
    expect(clampPan({ x: -9999, y: 9999 }, 2, 800, 600)).toEqual({ x: -400, y: 300 });
  });

  it('leaves a pan that is already inside the bounds alone', () => {
    expect(clampPan({ x: 40, y: -30 }, 3, 800, 600)).toEqual({ x: 40, y: -30 });
  });
});
