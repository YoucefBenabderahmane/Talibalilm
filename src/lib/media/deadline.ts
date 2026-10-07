/**
 * A promise that must answer by a deadline.
 *
 * Server Action calls and direct PUTs both hang the same way: a connection that
 * is accepted and then never answered. The action or the socket may recover
 * later, but the caller cannot wait on it — this turns "never" into a named
 * failure the screen can show, and the caller moves on.
 *
 * The deadline does not cancel the work underneath. For a PUT that is fine —
 * the object either lands or it does not, and the next page does not depend on
 * it. For a Server Action it means the server may still finish its side; the
 * caller has simply stopped holding the lesson open for it.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * An abort signal that fires after a while.
 *
 * `AbortSignal.timeout` is the one-liner, and it is missing on Safari before
 * 16 — where calling it threw and every upload was reported as a failure the
 * browser could actually have completed. The controller is the same behaviour
 * on every browser; the native one is used when it exists.
 */
export function abortAfter(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
