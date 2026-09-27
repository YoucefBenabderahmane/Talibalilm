import { describe, expect, it } from 'vitest';
import {
  FAST_WIDTH,
  PageReorder,
  pdfTargetWidth,
  pdfWorkerCount,
  SHARP_WIDTH,
} from '../../src/lib/media/pdf-plan';

/**
 * How long a large deck takes is decided by two numbers — how many pages render
 * at once and how wide each one is — and by the buffer that keeps the deck in
 * page order when they finish out of order.
 */
describe('how a PDF is turned into slides', () => {
  it('keeps the sharp width for a short deck and saves pixels on a long one', () => {
    expect(pdfTargetWidth(1)).toBe(SHARP_WIDTH);
    expect(pdfTargetWidth(40)).toBe(SHARP_WIDTH);
    expect(pdfTargetWidth(41)).toBe(FAST_WIDTH);
    expect(pdfTargetWidth(200)).toBe(FAST_WIDTH);
  });

  it('uses half the cores, between two and four', () => {
    expect(pdfWorkerCount(4, 1_000_000, 100)).toBe(2);
    expect(pdfWorkerCount(8, 1_000_000, 100)).toBe(4);
    expect(pdfWorkerCount(16, 1_000_000, 100)).toBe(4);
    // A modest machine still gets two rather than one.
    expect(pdfWorkerCount(2, 1_000_000, 100)).toBe(2);
  });

  it('drops to two workers for a very large file', () => {
    expect(pdfWorkerCount(16, 80 * 1024 * 1024, 100)).toBe(2);
  });

  it('never spawns more workers than pages, and never zero', () => {
    expect(pdfWorkerCount(16, 1_000_000, 2)).toBe(2);
    expect(pdfWorkerCount(16, 1_000_000, 1)).toBe(1);
  });
});

describe('the page-order buffer', () => {
  it('releases a run only once every page before it has arrived', () => {
    const buffer = new PageReorder<string>();

    expect(buffer.push(3, 'c')).toEqual([]);
    expect(buffer.push(1, 'a')).toEqual(['a']);
    expect(buffer.held).toBe(1);
    // 2 completes the run 1..3, so all three come out together, in order.
    expect(buffer.push(2, 'b')).toEqual(['b', 'c']);
    expect(buffer.held).toBe(0);
  });

  it('passes an in-order deck straight through', () => {
    const buffer = new PageReorder<number>();
    expect(buffer.push(1, 1)).toEqual([1]);
    expect(buffer.push(2, 2)).toEqual([2]);
    expect(buffer.push(3, 3)).toEqual([3]);
  });

  it('ignores a page that was already released', () => {
    const buffer = new PageReorder<number>();
    buffer.push(1, 1);
    expect(buffer.push(1, 99)).toEqual([]);
  });

  it('holds a whole out-of-order tail until the gap is filled', () => {
    const buffer = new PageReorder<number>();
    for (const page of [5, 4, 3, 2]) expect(buffer.push(page, page)).toEqual([]);
    expect(buffer.held).toBe(4);
    expect(buffer.push(1, 1)).toEqual([1, 2, 3, 4, 5]);
  });
});
