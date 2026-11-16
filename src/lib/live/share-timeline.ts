/**
 * Where the time goes when a screen share starts.
 *
 * A teacher reported that, once her students had joined, Chrome's « choose
 * what to share » window took over two minutes to open. Measured on the
 * room's own code (real LiveKit server, recording, camera, a 500-page PDF,
 * three students speaking, after 30 minutes of class), her click reached
 * Chrome in under a quarter of a second. The minutes are spent in a step we
 * cannot see from a test bench, so every share now records its own
 * timeline, and the room shows it to her.
 *
 * The steps, all on `performance.now()`'s clock:
 * - clicked: when the browser received her click (the event's timeStamp);
 * - handled: when the room's code ran for it. A gap here means the page's
 *   thread was busy;
 * - requested: when the room asked Chrome for its picker (getDisplayMedia);
 * - chosen: when Chrome answered. This includes her own time in the picker,
 *   so a long step here is Chrome or the choice, never the room;
 * - published: when the media server confirmed the share;
 * - received: when the first student was subscribed to it.
 *
 * Pure, so the readout and its tests agree on what each number means.
 */

export interface ShareStamps {
  clicked: number | null;
  handled: number;
  requested: number | null;
  chosen: number | null;
  published: number | null;
  received: number | null;
}

export type ShareOutcome = 'started' | 'cancelled' | 'refused' | 'failed';

export interface ShareSteps {
  /** Click → the room's code ran: the page's own thread. */
  page: number | null;
  /** The room's code → Chrome asked: should be about zero. */
  site: number | null;
  /** Chrome's picker, including the time spent choosing. */
  chrome: number | null;
  /** Screen chosen → the media server confirmed the share. */
  send: number | null;
  /** Confirmed → the first student subscribed. */
  receive: number | null;
}

const gap = (from: number | null, to: number | null): number | null =>
  from === null || to === null ? null : Math.max(0, Math.round(to - from));

export function shareSteps(stamps: ShareStamps): ShareSteps {
  return {
    page: gap(stamps.clicked, stamps.handled),
    site: gap(stamps.handled, stamps.requested),
    chrome: gap(stamps.requested, stamps.chosen),
    send: gap(stamps.chosen, stamps.published),
    receive: gap(stamps.published, stamps.received),
  };
}

/** A step slower than this is pointed out on screen and reported. */
export const SLOW_STEP_MS = 3000;

/** The slowest step, when one is slow enough to be worth pointing at. */
export function slowestStep(steps: ShareSteps): keyof ShareSteps | null {
  let worst: keyof ShareSteps | null = null;
  for (const key of Object.keys(steps) as (keyof ShareSteps)[]) {
    const value = steps[key];
    if (value === null || value < SLOW_STEP_MS) continue;
    if (worst === null || value > (steps[worst] ?? 0)) worst = key;
  }
  return worst;
}

/**
 * What a refused share means, and the browser's own words for it.
 *
 * Closing the picker without choosing is a decision, not a failure: Chrome
 * reports it as a NotAllowedError whose message is just "Permission denied".
 * Any other NotAllowedError is the system or a policy saying no (Windows
 * privacy settings, an administrator, "Permission denied by system"). Anything
 * else (no screen, the capture failing, the publish refused) is a failure.
 */
export function classifyShareError(error: unknown): {
  outcome: Exclude<ShareOutcome, 'started'>;
  detail: string;
} {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  const message =
    error instanceof Error || error instanceof DOMException ? error.message : String(error);
  const detail = name ? `${name}: ${message}` : message;
  if (name === 'NotAllowedError') {
    return {
      outcome: /^permission denied\.?$/i.test(message.trim()) ? 'cancelled' : 'refused',
      detail,
    };
  }
  if (name === 'AbortError' && /cancel/i.test(message)) return { outcome: 'cancelled', detail };
  return { outcome: 'failed', detail };
}

/** Seconds with one decimal, the way the readout prints a step. */
export function seconds(ms: number | null, locale: string): string | null {
  if (ms === null) return null;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ms / 1000);
}
