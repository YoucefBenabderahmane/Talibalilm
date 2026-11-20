/**
 * One upload at a time, for the whole page.
 *
 * The course editor shows a video uploader and a PDF uploader for every
 * lesson, and nothing stopped a teacher from starting two at once. They then
 * compete for the same home uplink and the same storage: on 20 November a PDF
 * sent while the lesson's video was going got no bytes through for two minutes
 * and was abandoned. The uplink is the limit either way, so sending files one
 * after another is never slower in total — it only stops them starving each
 * other.
 *
 * A queue in arrival order: an uploader takes its turn, waits while another
 * file is going, and hands the turn on when it ends — succeeded, failed or
 * cancelled alike, which is why callers release in a `finally`.
 */

export interface UploadLane {
  /**
   * Resolves with `release` once it is this upload's turn. `onWait(true)` while
   * another file goes first, `onWait(false)` when the turn comes. Rejects with
   * the signal's reason if `signal` aborts before then.
   */
  take(signal?: AbortSignal, onWait?: (waiting: boolean) => void): Promise<() => void>;
}

interface Waiter {
  grant: () => void;
}

export function createUploadLane(): UploadLane {
  let busy = false;
  const queue: Waiter[] = [];

  const releaser = () => {
    let released = false;
    return () => {
      // Twice is once: a second call must not hand on a turn it no longer holds.
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) next.grant();
      else busy = false;
    };
  };

  return {
    take(signal, onWait) {
      return new Promise((resolve, reject) => {
        const aborted = () => signal?.reason ?? new DOMException('Aborted', 'AbortError');
        if (signal?.aborted) {
          reject(aborted());
          return;
        }
        if (!busy) {
          busy = true;
          resolve(releaser());
          return;
        }
        const leave = () => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          onWait?.(false);
          reject(aborted());
        };
        const waiter: Waiter = {
          grant: () => {
            signal?.removeEventListener('abort', leave);
            onWait?.(false);
            resolve(releaser());
          },
        };
        signal?.addEventListener('abort', leave, { once: true });
        queue.push(waiter);
        onWait?.(true);
      });
    },
  };
}

/** The page's lane: every lesson's video and PDF uploaders share it. */
export const uploadLane = createUploadLane();
