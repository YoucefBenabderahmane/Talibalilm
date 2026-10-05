/**
 * What browsers say to each other inside a classroom.
 *
 * LiveKit carries these on its data channel. Two things make them safe to act
 * on, and neither is the page being well behaved:
 *
 *   * Identity is signed. The sender's `identity` and `metadata` were put into
 *     their token by our server after the database said who they are, so a
 *     student cannot appear as the teacher or claim to be one.
 *   * Host-only messages are ignored from anyone else. `acceptFrom` below is
 *     the rule, applied on receipt rather than trusted on send — a student who
 *     hand-crafts a `slide` or `board-clear` gets it dropped by every browser
 *     in the room. Asking for the lesson's state is not host-only: a student
 *     may ask, but only the teacher's answer is acted on.
 *
 * Anything that must SURVIVE the lesson does not travel here at all. Muting,
 * removing, allowing a camera: those are server actions that write to the
 * database and rewrite the LiveKit permission, so they hold after a reload and
 * do not depend on a message arriving.
 */

/** One mark on the whiteboard. Small and self-contained: never the whole canvas. */
export type BoardOp =
  /**
   * A pen stroke — or, when `erase` is set, a pass of the rubber. The flag is
   * what makes the eraser erase: the receiver clears those pixels rather than
   * painting the board's colour over them, so a board with a background of its
   * own keeps it, and a redraw after a resize is identical to what was drawn.
   */
  | { t: 'stroke'; pts: number[]; color: string; w: number; erase?: boolean }
  | {
      t: 'shape';
      kind: 'rect' | 'ellipse' | 'line';
      x: number;
      y: number;
      w: number;
      h: number;
      color: string;
      lw: number;
    }
  | { t: 'text'; x: number; y: number; s: string; color: string; size: number };

export type RoomMessage =
  /** Said by anyone in the room. */
  | { t: 'chat'; body: string }
  | { t: 'hand'; up: boolean }
  | { t: 'ask'; what: 'camera' | 'screen' }
  /**
   * "Where are we?" — sent by a browser that has just joined. The teacher
   * answers with `focus` and the current slide, so a latecomer lands on the
   * lesson rather than on the tab they would have seen at the door. Anyone may
   * ask; only the teacher answers, and the answer is idempotent.
   */
  | { t: 'sync' }
  /** Said only by the teacher. Dropped if it arrives from anyone else. */
  | { t: 'board'; op: BoardOp }
  | { t: 'board-clear' }
  | { t: 'slide'; i: number }
  | { t: 'rec'; on: boolean }
  /**
   * The deck changed — slides were just added. The message carries no slide
   * data: each viewer re-reads the deck from the server, because a slide link
   * is signed for the person who may open it and a URL from the teacher's
   * browser is not one a student should be handed.
   */
  | { t: 'deck' }
  /**
   * Where the teacher is looking, so the class follows: the panel tab, whether
   * the board is on the main stage, and whether a running screen share has been
   * reduced to the corner. A student may look elsewhere between these — it only
   * moves when the teacher does.
   */
  | {
      t: 'focus';
      tab: 'chat' | 'people' | 'board' | 'slides';
      boardOnStage?: boolean;
      sharePip?: boolean;
    }
  | { t: 'ended' };

export type RoomMessageKind = RoomMessage['t'];

/**
 * The messages a student's browser must refuse to believe.
 *
 * Presenting the slides, drawing the board, announcing a recording and ending
 * the class are the teacher's to do. A student's LiveKit token does let them
 * publish data — they need it for the chat — so the refusal cannot live in the
 * token the way muting does. It lives here instead, on every receiver.
 */
const HOST_ONLY: ReadonlySet<RoomMessageKind> = new Set<RoomMessageKind>([
  'board',
  'board-clear',
  'slide',
  'rec',
  'deck',
  'focus',
  'ended',
]);

/** Would this message be acted on, given who sent it? */
export function acceptFrom(message: RoomMessage, senderIsHost: boolean): boolean {
  return senderIsHost || !HOST_ONLY.has(message.t);
}

const MAX_BYTES = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeMessage(message: RoomMessage): Uint8Array<ArrayBuffer> {
  // The explicit buffer type is what LiveKit's publishData wants: TextEncoder
  // is typed as possibly backed by a SharedArrayBuffer, which it never is here.
  return encoder.encode(JSON.stringify(message)) as Uint8Array<ArrayBuffer>;
}

/**
 * Read a message off the wire, or null.
 *
 * Everything arriving here came from another browser, so it is parsed
 * defensively: malformed JSON, an unknown shape or an oversized payload are
 * dropped rather than thrown, because one peer sending nonsense must not take
 * the classroom down for everyone else.
 */
export function decodeMessage(payload: Uint8Array): RoomMessage | null {
  if (payload.byteLength > MAX_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(payload));
    if (!parsed || typeof parsed !== 'object') return null;
    const kind = (parsed as { t?: unknown }).t;
    if (typeof kind !== 'string') return null;

    switch (kind) {
      case 'chat': {
        const body = (parsed as { body?: unknown }).body;
        if (typeof body !== 'string' || body.trim() === '' || body.length > 2000) return null;
        return { t: 'chat', body };
      }
      case 'hand':
        return { t: 'hand', up: Boolean((parsed as { up?: unknown }).up) };
      case 'ask': {
        const what = (parsed as { what?: unknown }).what;
        if (what !== 'camera' && what !== 'screen') return null;
        return { t: 'ask', what };
      }
      case 'sync':
        return { t: 'sync' };
      case 'board': {
        const op = (parsed as { op?: unknown }).op;
        return isBoardOp(op) ? { t: 'board', op } : null;
      }
      case 'board-clear':
        return { t: 'board-clear' };
      case 'slide': {
        const i = (parsed as { i?: unknown }).i;
        if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i > 9999) return null;
        return { t: 'slide', i };
      }
      case 'rec':
        return { t: 'rec', on: Boolean((parsed as { on?: unknown }).on) };
      case 'deck':
        return { t: 'deck' };
      case 'focus': {
        const tab = (parsed as { tab?: unknown }).tab;
        if (tab !== 'chat' && tab !== 'people' && tab !== 'board' && tab !== 'slides') return null;
        const boardOnStage = (parsed as { boardOnStage?: unknown }).boardOnStage;
        if (boardOnStage !== undefined && typeof boardOnStage !== 'boolean') return null;
        const sharePip = (parsed as { sharePip?: unknown }).sharePip;
        if (sharePip !== undefined && typeof sharePip !== 'boolean') return null;
        return {
          t: 'focus',
          tab,
          ...(boardOnStage === undefined ? {} : { boardOnStage }),
          ...(sharePip === undefined ? {} : { sharePip }),
        };
      }
      case 'ended':
        return { t: 'ended' };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function isBoardOp(value: unknown): value is BoardOp {
  if (!value || typeof value !== 'object') return false;
  const op = value as Record<string, unknown>;
  if (op.t === 'stroke') {
    return (
      Array.isArray(op.pts) &&
      op.pts.length >= 2 &&
      op.pts.length <= 4000 &&
      op.pts.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      typeof op.color === 'string' &&
      typeof op.w === 'number' &&
      (op.erase === undefined || typeof op.erase === 'boolean')
    );
  }
  if (op.t === 'shape') {
    return (
      (op.kind === 'rect' || op.kind === 'ellipse' || op.kind === 'line') &&
      ['x', 'y', 'w', 'h', 'lw'].every(
        (k) => typeof op[k] === 'number' && Number.isFinite(op[k] as number),
      ) &&
      typeof op.color === 'string'
    );
  }
  if (op.t === 'text') {
    return (
      typeof op.s === 'string' &&
      op.s.length <= 500 &&
      ['x', 'y', 'size'].every((k) => typeof op[k] === 'number') &&
      typeof op.color === 'string'
    );
  }
  return false;
}

/**
 * Is this participant the teacher?
 *
 * Read from the metadata our server signed into their token, never from
 * anything the browser announced about itself.
 */
export function participantIsHost(metadata: string | undefined): boolean {
  if (!metadata) return false;
  try {
    return (JSON.parse(metadata) as { role?: string }).role === 'host';
  } catch {
    return false;
  }
}
