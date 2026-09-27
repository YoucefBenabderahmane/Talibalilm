/**
 * The arithmetic behind the slide zoom.
 *
 * Pure and exported so the clamps are tested without a browser: a wheel that
 * zooms past the point where the page is a smear, or a drag that throws the
 * slide off the stage and leaves the teacher staring at black, are the two
 * ways this goes wrong.
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/**
 * The scale after one wheel event.
 *
 * Exponential rather than a fixed step: a mouse wheel sends one event per
 * notch and a trackpad sends a stream of small ones, and multiplying keeps
 * both feeling the same. Scrolling up (a negative delta) zooms in.
 */
export function nextZoom(current: number, deltaY: number): number {
  const next = current * Math.exp(-deltaY * 0.0015);
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * Keep the panned slide from leaving the stage.
 *
 * The image is letterboxed inside the container, so this cannot know the exact
 * picture bounds; it bounds the *container* instead, which is enough to stop
 * the page being dragged into a corner of black. At 1× there is nowhere to go.
 */
export function clampPan(
  offset: { x: number; y: number },
  scale: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const maxX = (width * (scale - 1)) / 2;
  const maxY = (height * (scale - 1)) / 2;
  // `+ 0` on the way out: clamping a negative against a bound of zero produces
  // `-0`, which is the same number on screen and a different one in a test.
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)) + 0,
    y: Math.min(maxY, Math.max(-maxY, offset.y)) + 0,
  };
}
