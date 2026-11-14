import { describe, expect, it } from 'vitest';
import {
  clampPan,
  fitRect,
  MAX_ZOOM,
  MIN_ZOOM,
  nextZoom,
  normalizePoint,
  steppedZoom,
  zoomAbout,
} from '../../src/lib/live/zoom';

describe('the + and − buttons, and a pinch', () => {
  it('step by half, inside the limits', () => {
    expect(steppedZoom(1, 1)).toBe(1.5);
    expect(steppedZoom(1.5, -1)).toBe(1);
    expect(steppedZoom(1, -1)).toBe(MIN_ZOOM);
    expect(steppedZoom(3.9, 1)).toBe(MAX_ZOOM);
  });

  it('zooming about a point keeps that point where it was', () => {
    // A point 200px right of the centre, at 1×, then pushed in to 2× about
    // it: the page content under it must still be under it. Content at
    // offset c maps to screen x = c·scale + pan; the point is at c = 200.
    const after = zoomAbout({ scale: 1, x: 0, y: 0 }, 2, { x: 200, y: -100 }, 800, 600);
    expect(after.scale).toBe(2);
    expect(200 * after.scale + after.x).toBe(200);
    expect(-100 * after.scale + after.y).toBe(-100);
  });

  it('a zoom that lands on the same scale changes nothing', () => {
    const view = { scale: MAX_ZOOM, x: 10, y: 10 };
    expect(zoomAbout(view, 9, { x: 50, y: 50 }, 800, 600)).toBe(view);
  });

  it('cannot pan the page off the stage while zooming', () => {
    const after = zoomAbout({ scale: 1, x: 0, y: 0 }, 4, { x: 400, y: 300 }, 800, 600);
    expect(Math.abs(after.x)).toBeLessThanOrEqual(1200);
    expect(Math.abs(after.y)).toBeLessThanOrEqual(900);
  });
});

describe('where the page is inside its box', () => {
  it('letterboxes a wide page in a tall box, and the reverse', () => {
    // A 16:9 page in a square box: full width, centred vertically.
    expect(fitRect({ left: 0, top: 0, width: 800, height: 800 }, 1600, 900)).toEqual({
      left: 0,
      top: 175,
      width: 800,
      height: 450,
    });
    // A portrait page in a wide box: full height, centred horizontally.
    const portrait = fitRect({ left: 100, top: 50, width: 1000, height: 500 }, 600, 900);
    expect(portrait.top).toBe(50);
    expect(portrait.height).toBe(500);
    expect(portrait.width).toBeCloseTo(1000 / 3, 6);
    expect(portrait.left).toBeCloseTo(100 + (1000 - 1000 / 3) / 2, 6);
  });

  it('takes the whole box while the page has no size yet', () => {
    const box = { left: 5, top: 5, width: 300, height: 200 };
    expect(fitRect(box, 0, 0)).toBe(box);
  });

  it('turns a pointer into page fractions, and nothing when it is off the page', () => {
    const page = { left: 100, top: 50, width: 800, height: 450 };
    expect(normalizePoint(500, 275, page)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizePoint(100, 50, page)).toEqual({ x: 0, y: 0 });
    expect(normalizePoint(900, 500, page)).toEqual({ x: 1, y: 1 });
    expect(normalizePoint(99, 275, page)).toBeNull();
    expect(normalizePoint(500, 501, page)).toBeNull();
    expect(normalizePoint(500, 275, { ...page, width: 0 })).toBeNull();
  });
});

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

  it('reads a trackpad pinch (ctrl + wheel) as the scale it means', () => {
    // A pinch delta of about −70 is what a browser sends for a doubling;
    // read as a scroll it would barely move.
    expect(nextZoom(1, -69.3, true)).toBeCloseTo(2, 2);
    expect(nextZoom(2, 69.3, true)).toBeCloseTo(1, 2);
    expect(nextZoom(1, -69.3, false)).toBeLessThan(1.2);
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
