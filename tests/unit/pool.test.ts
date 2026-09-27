import { describe, expect, it } from 'vitest';
import { runPool } from '../../src/lib/media/pool';

/**
 * A slide deck is uploaded through a pool, and the number in it is the whole
 * point: too wide and a home uplink starts dropping pages, too narrow and the
 * connection sits idle between them.
 */
describe('the upload pool', () => {
  it('never has more than the limit in flight', async () => {
    let active = 0;
    let peak = 0;

    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });

    expect(peak).toBe(3);
  });

  it('runs every item exactly once, in order', async () => {
    const seen: number[] = [];
    await runPool([10, 20, 30], 2, async (item) => {
      seen.push(item);
    });
    expect(seen).toEqual([10, 20, 30]);
  });

  it('works when the pool is wider than the work', async () => {
    const seen: number[] = [];
    await runPool([1], 8, async (item) => {
      seen.push(item);
    });
    expect(seen).toEqual([1]);
  });

  it('does nothing for an empty list', async () => {
    await expect(runPool([], 3, async () => {})).resolves.toBeUndefined();
  });

  it('lets a failure end the worker without stranding the others', async () => {
    const seen: number[] = [];
    await expect(
      runPool([1, 2, 3], 1, async (item) => {
        seen.push(item);
        if (item === 2) throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    expect(seen).toEqual([1, 2]);
  });
});
