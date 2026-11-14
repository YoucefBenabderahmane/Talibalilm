import { describe, expect, it } from 'vitest';
import { createCursorFeed } from '@/lib/live/cursor-feed';

describe('the teacher cursor feed', () => {
  it('hands each position to its listeners and remembers the last one', () => {
    const feed = createCursorFeed();
    const seen: unknown[] = [];
    const stop = feed.subscribe((p) => seen.push(p));
    feed.set({ x: 0.25, y: 0.5 });
    feed.set(null);
    expect(seen).toEqual([{ x: 0.25, y: 0.5 }, null]);
    expect(feed.get()).toBeNull();
    stop();
    feed.set({ x: 1, y: 1 });
    expect(seen).toHaveLength(2);
    expect(feed.get()).toEqual({ x: 1, y: 1 });
  });
});
