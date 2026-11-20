import { describe, expect, it } from 'vitest';
import { createUploadLane } from '@/lib/media/upload-lane';

/** Lets every resolved promise run its continuations. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the upload lane', () => {
  it('lets the first upload go at once, and the next ones in the order they came', async () => {
    const lane = createUploadLane();
    const order: string[] = [];
    const first = await lane.take();
    const second = lane.take().then((release) => {
      order.push('second');
      return release;
    });
    const third = lane.take().then((release) => {
      order.push('third');
      return release;
    });
    await settle();
    expect(order).toEqual([]);

    first();
    const releaseSecond = await second;
    await settle();
    expect(order).toEqual(['second']);

    releaseSecond();
    (await third)();
    expect(order).toEqual(['second', 'third']);
  });

  it('says when an upload is waiting, and when its turn comes', async () => {
    const lane = createUploadLane();
    const first = await lane.take();
    const seen: boolean[] = [];
    const second = lane.take(undefined, (waiting) => seen.push(waiting));
    expect(seen).toEqual([true]);
    first();
    await second;
    expect(seen).toEqual([true, false]);
  });

  it('hands a turn on once, however many times it is released', async () => {
    // A `finally` and an error path can both release: the third upload must
    // still wait for the second.
    const lane = createUploadLane();
    const first = await lane.take();
    let thirdStarted = false;
    const second = lane.take();
    void lane.take().then(() => (thirdStarted = true));
    first();
    first();
    await second;
    await settle();
    expect(thirdStarted).toBe(false);
  });

  it('lets a waiting upload be cancelled, and the queue goes on without it', async () => {
    const lane = createUploadLane();
    const first = await lane.take();
    const cancel = new AbortController();
    const seen: boolean[] = [];
    const cancelled = lane.take(cancel.signal, (waiting) => seen.push(waiting));
    const third = lane.take();

    cancel.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual([true, false]);

    first();
    await expect(third).resolves.toBeTypeOf('function');
  });

  it('refuses at once an upload cancelled before it asked', async () => {
    const lane = createUploadLane();
    const cancel = new AbortController();
    cancel.abort();
    await expect(lane.take(cancel.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    // And the lane is still free.
    await expect(lane.take()).resolves.toBeTypeOf('function');
  });

  it('is free again once the last upload has ended', async () => {
    const lane = createUploadLane();
    (await lane.take())();
    const seen: boolean[] = [];
    await lane.take(undefined, (waiting) => seen.push(waiting));
    expect(seen).toEqual([]);
  });
});
