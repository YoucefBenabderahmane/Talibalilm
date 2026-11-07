import { describe, expect, it } from 'vitest';
import { addPoint, asStroke, toCanvasPoint } from '@/lib/live/marks';

const W = 1920;
const H = 1080;

describe('toCanvasPoint', () => {
  it('maps a canvas shown at its exact shape, corner to corner', () => {
    const rect = { left: 100, top: 50, width: 960, height: 540 };
    expect(toCanvasPoint(100, 50, rect, W, H)).toEqual({ x: 0, y: 0 });
    expect(toCanvasPoint(1060, 590, rect, W, H)).toEqual({ x: 1920, y: 1080 });
    expect(toCanvasPoint(580, 320, rect, W, H)).toEqual({ x: 960, y: 540 });
  });

  it('accounts for the black bands of a box taller than the page', () => {
    // 960 wide, 740 tall: the page is 540 tall, centred with 100px above and below.
    const rect = { left: 0, top: 0, width: 960, height: 740 };
    expect(toCanvasPoint(0, 100, rect, W, H)).toEqual({ x: 0, y: 0 });
    expect(toCanvasPoint(960, 640, rect, W, H)).toEqual({ x: 1920, y: 1080 });
  });

  it('accounts for the black bands of a box wider than the page', () => {
    // 1160 wide, 540 tall: the page is 960 wide, 100px either side.
    const rect = { left: 0, top: 0, width: 1160, height: 540 };
    expect(toCanvasPoint(100, 0, rect, W, H)).toEqual({ x: 0, y: 0 });
    expect(toCanvasPoint(580, 270, rect, W, H)).toEqual({ x: 960, y: 540 });
  });

  it('lands on the same spot of the page when the teacher has zoomed in', () => {
    // The same page at 2×: the box on screen is twice as large, shifted.
    const fitted = { left: 0, top: 0, width: 960, height: 540 };
    const zoomed = { left: -480, top: -270, width: 1920, height: 1080 };
    expect(toCanvasPoint(480, 270, fitted, W, H)).toEqual({ x: 960, y: 540 });
    expect(toCanvasPoint(480, 270, zoomed, W, H)).toEqual({ x: 960, y: 540 });
  });

  it('keeps a pointer past the edge on the page', () => {
    const rect = { left: 0, top: 0, width: 960, height: 540 };
    expect(toCanvasPoint(-50, 900, rect, W, H)).toEqual({ x: 0, y: 1080 });
  });
});

describe('addPoint', () => {
  it('keeps samples that move, and skips the ones on top of the last', () => {
    const points: number[] = [];
    expect(addPoint(points, 10, 10)).toBe(true);
    expect(addPoint(points, 11, 10)).toBe(false);
    expect(addPoint(points, 15, 10)).toBe(true);
    expect(points).toEqual([10, 10, 15, 10]);
  });
});

describe('asStroke', () => {
  it('accepts a stored stroke as it was saved', () => {
    const stroke = { color: '#ef4444', width: 6, points: [1, 2, 3, 4] };
    expect(asStroke(stroke)).toEqual(stroke);
  });

  it('refuses anything that is not a whole stroke', () => {
    expect(asStroke(null)).toBeNull();
    expect(asStroke({ color: '#fff', width: 6, points: [1] })).toBeNull();
    expect(asStroke({ color: '#fff', width: 6, points: [1, Number.NaN] })).toBeNull();
    expect(asStroke({ color: 1, width: 6, points: [1, 2] })).toBeNull();
  });
});
