/**
 * Run async work with a bounded number of tasks in flight.
 *
 * A slide upload is a PUT to Cloudflare per page. Firing forty at once
 * saturates a home uplink and starts failing pages for no gain, and firing one
 * at a time leaves the connection idle for most of the deck — so the count is
 * small and fixed, and this is the loop that holds it.
 *
 * Pure and exported so the limit is tested without a network.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await worker(items[index] as T, index);
      }
    }),
  );
}
