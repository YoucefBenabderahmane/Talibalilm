/**
 * The teacher's pen on a slide.
 *
 * A mark is drawn on the very canvas the page is streamed from, so the class
 * sees it as she draws and the recording keeps it. Marks belong to a page, not
 * to the moment: turning the page, opening another PDF and coming back finds
 * them where she left them, until that page or its PDF is removed.
 *
 * Points are kept in stage pixels — the 1920×1080 box every page is drawn in —
 * so a mark lands on the same word whatever the size of the teacher's screen,
 * and whether or not she has zoomed in on the page.
 */

export interface Stroke {
  color: string;
  /** In stage pixels. */
  width: number;
  /** x, y, x, y… in stage pixels. */
  points: number[];
}

/** Red first: it is what a teacher reaches for to circle a word. */
export const PEN_COLORS = [
  { key: 'red', value: '#ef4444' },
  { key: 'yellow', value: '#facc15' },
  { key: 'green', value: '#22c55e' },
  { key: 'blue', value: '#3b82f6' },
  { key: 'white', value: '#ffffff' },
] as const;

export type PenColorKey = (typeof PEN_COLORS)[number]['key'];

/** About as thick as a felt pen on the page: 6 of 1920 pixels. */
export const PEN_WIDTH = 6;

/** Closer than this, a pointer sample adds nothing a line needs. */
const MIN_STEP = 2;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a pointer lands on a canvas shown with `object-contain`.
 *
 * `rect` is the canvas element's box on screen, transforms included, so a page
 * the teacher zoomed into maps exactly as one shown whole. The letterbox
 * around the picture is accounted for, and a pointer past the edge lands on
 * the edge rather than off the page.
 */
export function toCanvasPoint(
  clientX: number,
  clientY: number,
  rect: Box,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  const scale = Math.min(rect.width / canvasWidth, rect.height / canvasHeight) || 1;
  const left = rect.left + (rect.width - canvasWidth * scale) / 2;
  const top = rect.top + (rect.height - canvasHeight * scale) / 2;
  const x = Math.round((clientX - left) / scale);
  const y = Math.round((clientY - top) / scale);
  return {
    x: Math.min(canvasWidth, Math.max(0, x)),
    y: Math.min(canvasHeight, Math.max(0, y)),
  };
}

/** Add a sample to a stroke unless it is on top of the last one. True when added. */
export function addPoint(points: number[], x: number, y: number): boolean {
  const n = points.length;
  if (n >= 2) {
    const dx = x - (points[n - 2] ?? 0);
    const dy = y - (points[n - 1] ?? 0);
    if (dx * dx + dy * dy < MIN_STEP * MIN_STEP) return false;
  }
  points.push(x, y);
  return true;
}

/**
 * Draw a stroke, or only its tail: `from` is the index in `points` of the
 * first new sample, and the line is joined to the sample before it. A stroke
 * of one sample is a dot.
 */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, from = 0): void {
  const p = stroke.points;
  if (p.length < 2) return;
  const start = from >= 2 ? from - 2 : 0;
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(p[start] ?? 0, p[start + 1] ?? 0);
  if (p.length === 2) ctx.lineTo((p[0] ?? 0) + 0.01, p[1] ?? 0);
  for (let i = start + 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i] ?? 0, p[i + 1] ?? 0);
  ctx.stroke();
  ctx.restore();
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[]): void {
  for (const stroke of strokes) drawStroke(ctx, stroke);
}

/** A stroke read back from storage, or null if it is not one. */
export function asStroke(value: unknown): Stroke | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<Stroke>;
  if (typeof v.color !== 'string' || typeof v.width !== 'number' || !Array.isArray(v.points)) {
    return null;
  }
  if (v.points.length < 2 || v.points.length % 2 !== 0) return null;
  if (!v.points.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { color: v.color, width: v.width, points: v.points };
}
