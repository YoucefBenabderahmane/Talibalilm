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

/** Inside the limits, rounded so two routes to the same zoom agree. */
export function clampZoom(scale: number): number {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * The scale after one wheel event.
 *
 * Exponential rather than a fixed step: a mouse wheel sends one event per
 * notch and a trackpad sends a stream of small ones, and multiplying keeps
 * both feeling the same. Scrolling up (a negative delta) zooms in.
 *
 * A trackpad pinch arrives as a wheel event too, with `ctrlKey` set and a
 * delta that is a scale rather than a distance — about a hundred units for
 * a doubling. Read as scrolling it zoomed by a tenth per pinch; `pinch`
 * applies the factor browsers mean by it.
 */
export function nextZoom(current: number, deltaY: number, pinch = false): number {
  return clampZoom(current * Math.exp(-deltaY * (pinch ? 0.01 : 0.0015)));
}

/** One press of the + or − button: half again as large, or as small. */
export function steppedZoom(current: number, direction: 1 | -1): number {
  return clampZoom(direction > 0 ? current * 1.5 : current / 1.5);
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

/**
 * The view after zooming to `scale` about a point.
 *
 * `point` is measured from the container's centre, which is where the CSS
 * transform pivots. The point under the finger or the wheel stays where it
 * is: zooming about the centre instead means pushing in on a corner throws
 * that corner off the screen. The wheel, a pinch and a double-tap all come
 * through here, so they cannot disagree.
 */
export function zoomAbout(
  current: View,
  scale: number,
  point: { x: number; y: number },
  width: number,
  height: number,
): View {
  const next = clampZoom(scale);
  if (next === current.scale) return current;
  const factor = next / current.scale;
  const pan = clampPan(
    {
      x: current.x * factor + point.x * (1 - factor),
      y: current.y * factor + point.y * (1 - factor),
    },
    next,
    width,
    height,
  );
  return { scale: next, x: pan.x, y: pan.y };
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the picture actually is inside a letterboxed element.
 *
 * An `object-contain` image or video fills its element with black bars on
 * two sides; the teacher's pointer is measured against the page, not the
 * bars, so both ends need the picture's own box. An element with no known
 * size yet (an image still loading) is taken as the whole box.
 */
export function fitRect(box: Rect, naturalWidth: number, naturalHeight: number): Rect {
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || !(box.width > 0) || !(box.height > 0)) {
    return box;
  }
  const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * A point in page fractions (0–1 from the top-left), or null when it is off
 * the page. Four decimals: a page is never more than a few thousand pixels
 * wide, and the message is sent many times a second.
 */
export function normalizePoint(
  clientX: number,
  clientY: number,
  page: Rect,
): { x: number; y: number } | null {
  if (!(page.width > 0) || !(page.height > 0)) return null;
  const x = (clientX - page.left) / page.width;
  const y = (clientY - page.top) / page.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
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
