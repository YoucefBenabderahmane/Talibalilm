/**
 * The decisions behind turning a PDF into slides, as arithmetic.
 *
 * Kept apart from `pdf.ts` — which needs a DOM, a worker and a real document —
 * so the two things that decide how long a large deck takes can be tested on
 * their own: how many pages may render at once, and how wide each page is.
 */

/** A deck above this many pages trades sharpness for a shorter conversion. */
export const SMALL_DECK_PAGES = 40;
/** Wide enough to read a dense slide full-screen, small enough to upload quickly. */
export const SHARP_WIDTH = 1600;
/** The large-deck size: about 40 % fewer pixels, and bytes, per page. */
export const FAST_WIDTH = 1280;

const MIN_WORKERS = 2;
const MAX_WORKERS = 4;
/** Past this, extra workers cost more in memory than they save in time. */
const BIG_FILE_BYTES = 60 * 1024 * 1024;
/**
 * Past this, one worker: every worker holds its own copy of the document, and
 * two copies of a 200 MB PDF is how the tab dies before the deck is finished.
 * Slower, and it completes.
 */
const HUGE_FILE_BYTES = 120 * 1024 * 1024;

/** The width each page renders at, from how many pages the deck has. */
export function pdfTargetWidth(pages: number): number {
  return pages > SMALL_DECK_PAGES ? FAST_WIDTH : SHARP_WIDTH;
}

/**
 * How many pages may render at once.
 *
 * Half the cores, never more than four: pdf.js rendering is CPU-bound and one
 * worker per core leaves nothing for the rest of the tab. A very large file
 * drops to two, because every worker holds its own copy of the document while
 * it works. Never more workers than pages, and never fewer than one.
 */
export function pdfWorkerCount(cores: number, fileSize: number, pages: number): number {
  if (pages <= 1) return 1;
  if (fileSize > HUGE_FILE_BYTES) return 1;
  const byCores = Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, Math.floor(cores / 2)));
  const bySize = fileSize > BIG_FILE_BYTES ? MIN_WORKERS : byCores;
  return Math.max(1, Math.min(bySize, pages));
}

/**
 * Pages finishing out of order, released in order.
 *
 * Parallel workers mean page 7 is ready before page 5. The deck must still be
 * 1, 2, 3…, so finished pages wait here until every page before them has
 * arrived, and each push returns whatever run is now consecutive.
 */
export class PageReorder<T> {
  private readonly waiting = new Map<number, T>();
  /** Pages that will never arrive — a canvas that would not encode, even smaller. */
  private readonly missing = new Set<number>();
  private next = 1;

  push(page: number, value: T): T[] {
    if (page < this.next) return [];
    this.waiting.set(page, value);
    return this.drain();
  }

  /**
   * A page that will never arrive.
   *
   * Without this, one failed page held every page behind it in the buffer
   * forever and the deck silently ended there: the class lost everything after
   * the first canvas the browser could not encode. Marking it missing lets the
   * run behind it through.
   */
  skip(page: number): T[] {
    if (page < this.next) return [];
    this.waiting.delete(page);
    this.missing.add(page);
    return this.drain();
  }

  /** Whatever run is consecutive now, in page order. */
  private drain(): T[] {
    const ready: T[] = [];
    for (;;) {
      if (this.missing.has(this.next)) {
        this.missing.delete(this.next);
        this.next += 1;
        continue;
      }
      const value = this.waiting.get(this.next);
      if (value === undefined) break;
      ready.push(value);
      this.waiting.delete(this.next);
      this.next += 1;
    }
    return ready;
  }

  /** Pages finished but held back for an earlier one still rendering. */
  get held(): number {
    return this.waiting.size;
  }
}
