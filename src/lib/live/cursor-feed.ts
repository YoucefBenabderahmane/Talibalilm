/**
 * The teacher's pointer, as the class last heard of it.
 *
 * Positions arrive twenty-five times a second over the lossy channel. Fed
 * through React state they would re-render the whole stage — strip, tiles,
 * pager — at that rate; this is a plain pub/sub the cursor overlay subscribes
 * to on its own, so nothing else in the room notices the stream.
 *
 * A position is a fraction of the page (0–1 from its top-left corner), never
 * a pixel: the teacher's screen and a student's phone show the same page at
 * different sizes and zooms, and only the page coordinates survive that.
 */
export interface CursorPosition {
  x: number;
  y: number;
}

export interface CursorFeed {
  /** The last position, or null when the pointer is off the page. */
  get(): CursorPosition | null;
  subscribe(listener: (position: CursorPosition | null) => void): () => void;
  set(position: CursorPosition | null): void;
}

export function createCursorFeed(): CursorFeed {
  let current: CursorPosition | null = null;
  const listeners = new Set<(position: CursorPosition | null) => void>();
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(position) {
      current = position;
      for (const listener of listeners) listener(position);
    },
  };
}
