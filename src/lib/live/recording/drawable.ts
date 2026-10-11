/**
 * What the recorder may draw, decided before it draws.
 *
 * The recording is a canvas the browser encodes. Drawing ONE image the page is
 * not allowed to read — a slide served by R2 without a CORS answer — marks that
 * canvas "tainted", permanently. Chrome then mutes the captured video track and
 * the file stops gaining picture for the rest of the lesson, while the button
 * still says it is recording; the standard tells other browsers to stop the
 * recorder outright. That is the October 2026 class: ten minutes recorded, a
 * slide shown, and « Reprendre » that resumed nothing.
 *
 * So nothing is drawn on trust. An image is drawn only when the page can read
 * it: same origin, a `data:`/`blob:` URL, or loaded through CORS (an image whose
 * CORS request failed never finishes loading, so `crossOrigin` + loaded means
 * the answer was yes). Anything else is skipped and named, so the room can say
 * why the slides are missing from the file instead of freezing it.
 *
 * Pure on purpose: the decision is tested without a browser.
 */

export type DrawableKind = 'video' | 'canvas' | 'image';

export interface DrawableInfo {
  kind: DrawableKind;
  /** The URL actually loaded (`currentSrc`), for images. */
  src?: string;
  /** The element's `crossOrigin` attribute; null when it was loaded without CORS. */
  crossOrigin?: string | null;
  /** Has pixels to give: decoded image, video with a frame, canvas with a size. */
  ready: boolean;
}

export type DrawDecision = 'draw' | 'not-ready' | 'foreign';

export function drawDecision(info: DrawableInfo, pageOrigin: string): DrawDecision {
  if (!info.ready) return 'not-ready';
  // A <video> in the room plays a MediaStream from LiveKit, and the canvases are
  // the room's own whiteboard: both are readable by construction.
  if (info.kind !== 'image') return 'draw';

  const src = info.src ?? '';
  if (src.startsWith('data:') || src.startsWith('blob:')) return 'draw';
  if (info.crossOrigin !== null && info.crossOrigin !== undefined) return 'draw';

  try {
    return new URL(src, pageOrigin).origin === pageOrigin ? 'draw' : 'foreign';
  } catch {
    return 'foreign';
  }
}

/** Read a live element into the descriptor `drawDecision` judges. */
export function describe(
  element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
): DrawableInfo {
  if (element instanceof HTMLVideoElement) {
    return { kind: 'video', ready: element.videoWidth > 0 && element.videoHeight > 0 };
  }
  if (element instanceof HTMLCanvasElement) {
    return { kind: 'canvas', ready: element.width > 0 && element.height > 0 };
  }
  return {
    kind: 'image',
    src: element.currentSrc || element.src,
    crossOrigin: element.crossOrigin,
    ready: element.complete && element.naturalWidth > 0,
  };
}
