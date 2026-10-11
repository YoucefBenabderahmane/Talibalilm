import { describe, drawDecision } from './drawable';
import type { ChunkStore } from './chunk-store';
import { startTicker } from './ticker';

/**
 * One recording of the class, from « Enregistrer » to the downloaded file.
 *
 * Framework-free so the whole lifecycle runs — and is tested — in a real
 * browser without React. `useRecorder` is a thin wrapper around it.
 *
 * The rules it keeps, each one a failure a teacher has already lived through:
 *
 *   - The state shown is the state the browser's MediaRecorder reports, read
 *     after every call and on every event. A button that says "paused" while
 *     the recorder is dead is how « Reprendre » came to do nothing.
 *   - Nothing unreadable is ever drawn (see `drawable.ts`): one slide used to
 *     freeze the picture for the rest of the lesson.
 *   - Every failure is reported with the browser's own words, and whatever was
 *     recorded is saved at once. Nothing is lost silently.
 *   - Every chunk is written to disk as it arrives (`chunk-store.ts`), so a
 *     crash or a reload costs seconds, not the class.
 */

export type RecorderState = 'idle' | 'starting' | 'recording' | 'paused' | 'saving';

export type RecorderIssueCode =
  /** This browser cannot record a canvas at all. */
  | 'unsupported'
  /** The browser's recorder failed mid-lesson; what existed was saved. */
  | 'recorderFailed'
  /** « Pause » / « Reprendre » was refused by the browser. */
  | 'pauseFailed'
  | 'resumeFailed'
  /** Slides could not be drawn into the file (storage refuses CORS reads). */
  | 'slidesNotRecorded'
  /** The picture track went silent although nothing unreadable was drawn. */
  | 'pictureBlocked'
  /** The teacher's microphone was refused or lost and could not be re-opened. */
  | 'micUnavailable'
  /** The on-disk safety copy is off; the recording is in memory only. */
  | 'storageUnavailable';

export interface RecorderIssue {
  code: RecorderIssueCode;
  /** The browser's own words — shown to staff, never paraphrased away. */
  detail?: string;
  /** True for problems that stopped the recording; false for warnings. */
  fatal: boolean;
}

export interface RecordFrameItem {
  element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;
  rect: DOMRect;
}

export interface RecordFrame {
  container: DOMRect;
  items: RecordFrameItem[];
}

export interface RecordSources {
  stage: () => RecordFrame | null;
  audio: () => MediaStreamTrack[];
}

export interface SessionCallbacks {
  onState: (state: RecorderState) => void;
  onIssue: (issue: RecorderIssue) => void;
  /** Called with the finished file; the default hands it to the downloader. */
  onSaved?: (file: { blob: Blob; filename: string }) => void;
}

export interface SessionOptions extends SessionCallbacks {
  /** Download name without extension. */
  fileName: string;
  sources: RecordSources;
  store: ChunkStore | null;
  /** Injected for tests; defaults to the browser's own APIs. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const TIMESLICE_MS = 5_000;
/** Enough for slides and a face at 720p; about 0.7 GB an hour instead of ~1.1. */
const VIDEO_BPS = 1_500_000;
const AUDIO_BPS = 128_000;
/** How long a fresh download is given before the page may navigate away. */
const DOWNLOAD_GRACE_MS = 1_500;

export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const type of [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

function errorText(thrown: unknown): string {
  if (thrown && typeof thrown === 'object' && 'name' in thrown) {
    const { name, message } = thrown as { name?: string; message?: string };
    return `${name ?? 'Error'}: ${message ?? ''}`.trim();
  }
  return String(thrown);
}

/** Read without TypeScript's narrowing: the browser changes it under our feet. */
function stateOf(recorder: MediaRecorder): RecordingState {
  return recorder.state;
}

function originOf(src: string | undefined): string | undefined {
  try {
    return src ? new URL(src).origin : undefined;
  } catch {
    return undefined;
  }
}

function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on a timer: Safari has been known to abandon the download if the
  // URL dies in the same tick as the click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export class RecordingSession {
  private readonly options: SessionOptions;
  private state: RecorderState = 'idle';
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private mic: MediaStream | null = null;
  private readonly wired = new Map<string, MediaStreamAudioSourceNode>();
  private stopTicker: (() => void) | null = null;
  private rewire: ReturnType<typeof setInterval> | null = null;
  private chunks: Blob[] = [];
  private seq = 0;
  private storeId: string | null = null;
  private storeHealthy = false;
  private warned = new Set<RecorderIssueCode>();
  private stopWaiters: ((saved: boolean) => void)[] = [];
  private failed = false;
  private activeMs = 0;
  private runningSince: number | null = null;
  private micRetryAt = 0;
  /** Bumped by a stop during start-up, so the start that is still awaiting gives up. */
  private generation = 0;

  constructor(options: SessionOptions) {
    this.options = options;
  }

  get current(): RecorderState {
    return this.state;
  }

  /** Recorded time, excluding pauses. Computed, so a throttled timer cannot drift it. */
  elapsedSeconds(): number {
    const running = this.runningSince === null ? 0 : Date.now() - this.runningSince;
    return Math.floor((this.activeMs + running) / 1000);
  }

  /** The browser's MediaRecorder, for tests and diagnostics only. */
  get mediaRecorder(): MediaRecorder | null {
    return this.recorder;
  }

  private setState(next: RecorderState) {
    this.state = next;
    this.options.onState(next);
  }

  private issue(code: RecorderIssueCode, fatal: boolean, detail?: string) {
    // A warning is said once per recording; it is a fact about the lesson,
    // not an event worth repeating every frame.
    if (!fatal) {
      if (this.warned.has(code)) return;
      this.warned.add(code);
    }
    this.options.onIssue({ code, fatal, detail });
  }

  async start(): Promise<void> {
    // The lock that a double click used to walk through: two recorders writing
    // into one file, and only one of them ever stopped.
    if (this.state !== 'idle') return;
    const generation = ++this.generation;
    this.setState('starting');
    // « Arrêter » pressed while this was still awaiting: stop here, cleanly.
    const abandoned = () => {
      if (generation === this.generation && this.state === 'starting') return false;
      this.cleanup();
      return true;
    };

    if (typeof MediaRecorder === 'undefined' || typeof document === 'undefined') {
      this.issue('unsupported', true, 'MediaRecorder is not available in this browser');
      this.setState('idle');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.captureStream !== 'function') {
      this.issue('unsupported', true, 'canvas.captureStream is not available in this browser');
      this.setState('idle');
      return;
    }

    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.context = new Ctor();
      this.destination = this.context.createMediaStreamDestination();
      // A context the browser suspends (device change, Safari's interruptions)
      // records silence until someone resumes it. Nobody would; this does.
      this.context.addEventListener('statechange', () => {
        if (this.context?.state === 'suspended' && this.state === 'recording') {
          void this.context.resume().catch(() => {});
        }
      });
    } catch (thrown) {
      this.issue('unsupported', true, errorText(thrown));
      this.cleanup();
      this.setState('idle');
      return;
    }

    await this.openMic();
    if (abandoned()) return;
    this.wire();
    this.rewire = setInterval(() => this.wire(), 2000);
    this.stopTicker = startTicker(FPS, () => this.draw(ctx));

    const stream = new MediaStream([
      ...canvas.captureStream(FPS).getVideoTracks(),
      ...this.destination!.stream.getAudioTracks(),
    ]);
    this.videoTrack = stream.getVideoTracks()[0] ?? null;
    // Muted means the browser stopped giving the recorder pictures. With the
    // guard in `draw` it should never happen; if it does, say so at once.
    this.videoTrack?.addEventListener('mute', () => {
      this.issue('pictureBlocked', false, 'the canvas video track was muted by the browser');
    });

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: VIDEO_BPS,
        audioBitsPerSecond: AUDIO_BPS,
      });
    } catch (thrown) {
      this.issue('unsupported', true, errorText(thrown));
      this.cleanup();
      this.setState('idle');
      return;
    }
    this.recorder = recorder;
    this.chunks = [];
    this.seq = 0;
    this.failed = false;

    const store = this.options.store;
    if (store) {
      this.storeId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      this.storeHealthy = await store.begin({
        id: this.storeId,
        name: this.options.fileName,
        mimeType: recorder.mimeType || mimeType || 'video/webm',
        startedAt: Date.now(),
      });
    } else {
      this.storeHealthy = false;
    }
    if (abandoned()) return;
    if (!this.storeHealthy) {
      this.issue('storageUnavailable', false, store ? 'IndexedDB refused the recording' : 'no IndexedDB');
    }

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      this.chunks.push(event.data);
      const seq = this.seq++;
      if (store && this.storeId && this.storeHealthy) {
        void store.append(this.storeId, seq, event.data).then((ok) => {
          if (!ok) {
            this.storeHealthy = false;
            this.issue('storageUnavailable', false, 'IndexedDB refused a chunk (disk full?)');
          }
        });
      }
    };
    recorder.onpause = () => this.sync();
    recorder.onresume = () => this.sync();
    recorder.onerror = (event) => {
      const error = (event as unknown as { error?: unknown }).error;
      this.failed = true;
      this.issue('recorderFailed', true, errorText(error ?? 'MediaRecorder error'));
      // Whatever was recorded is saved now, not when somebody notices.
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          void this.save();
        }
      } else {
        void this.save();
      }
    };
    recorder.onstop = () => void this.save();

    try {
      recorder.start(TIMESLICE_MS);
    } catch (thrown) {
      this.issue('unsupported', true, errorText(thrown));
      this.cleanup();
      this.setState('idle');
      return;
    }
    this.activeMs = 0;
    this.runningSince = Date.now();
    this.sync();
  }

  /** Mirror the browser's recorder into our state. The browser is the truth. */
  private sync() {
    const recorder = this.recorder;
    if (!recorder || this.state === 'saving' || this.state === 'idle') return;
    if (recorder.state === 'recording') {
      if (this.runningSince === null) this.runningSince = Date.now();
      if (this.state !== 'recording') this.setState('recording');
    } else if (recorder.state === 'paused') {
      if (this.runningSince !== null) {
        this.activeMs += Date.now() - this.runningSince;
        this.runningSince = null;
      }
      if (this.state !== 'paused') this.setState('paused');
    }
  }

  pause(): boolean {
    const recorder = this.recorder;
    if (!recorder || recorder.state !== 'recording') {
      this.issue('pauseFailed', true, `recorder state: ${recorder?.state ?? 'none'}`);
      return false;
    }
    try {
      recorder.pause();
    } catch (thrown) {
      this.issue('pauseFailed', true, errorText(thrown));
      return false;
    }
    this.sync();
    return stateOf(recorder) === 'paused';
  }

  resume(): boolean {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      // The recorder died during the pause. Saying so — and saving what there
      // is — is the whole difference from a button that silently does nothing.
      this.issue('resumeFailed', true, `recorder state: ${recorder?.state ?? 'none'}`);
      void this.save();
      return false;
    }
    if (recorder.state === 'recording') {
      this.sync();
      return true;
    }
    try {
      recorder.resume();
    } catch (thrown) {
      this.issue('resumeFailed', true, errorText(thrown));
      return false;
    }
    if (this.context?.state === 'suspended') void this.context.resume().catch(() => {});
    this.sync();
    if (stateOf(recorder) !== 'recording') {
      this.issue('resumeFailed', true, `recorder state after resume: ${stateOf(recorder)}`);
      return false;
    }
    return true;
  }

  togglePause(): boolean {
    return this.recorder?.state === 'paused' ? this.resume() : this.pause();
  }

  /**
   * Stop and save. Resolves once the file has been handed over (true), or
   * straight away when there was nothing to save (false). Safe to call twice.
   */
  stop(): Promise<boolean> {
    const recorder = this.recorder;
    if (this.state === 'idle') return Promise.resolve(false);
    if (this.state === 'starting' && !recorder) {
      // Nothing recorded yet: abandon the start-up instead of racing it.
      this.generation++;
      this.cleanup();
      this.setState('idle');
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      this.stopWaiters.push(resolve);
      if (this.state === 'saving') return;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
          return;
        } catch {
          /* fall through to saving what we have */
        }
      }
      void this.save();
    });
  }

  private async save(): Promise<void> {
    if (this.state === 'saving' || this.state === 'idle') return;
    const recorder = this.recorder;
    if (this.runningSince !== null) {
      this.activeMs += Date.now() - this.runningSince;
      this.runningSince = null;
    }
    this.setState('saving');
    this.stopTicker?.();
    this.stopTicker = null;

    const mimeType = recorder?.mimeType || pickMimeType() || 'video/webm';
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    let saved = false;
    if (this.chunks.length > 0) {
      const blob = new Blob(this.chunks, { type: mimeType });
      const filename = `${this.options.fileName}.${extension}`;
      try {
        if (this.options.onSaved) {
          this.options.onSaved({ blob, filename });
        } else {
          downloadFile(blob, filename);
          // « Quitter » and « Terminer » navigate the moment this resolves. A
          // download handed over in the same instant as the page unloads can be
          // dropped with the page, so the browser is given a moment to take it.
          await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GRACE_MS));
        }
        saved = true;
        if (this.options.store && this.storeId) await this.options.store.markSaved(this.storeId);
      } catch (thrown) {
        // The disk copy stays unsaved, so the room offers it again on reload.
        this.issue('recorderFailed', true, `saving the file failed: ${errorText(thrown)}`);
      }
    }

    this.cleanup();
    this.setState('idle');
    const waiters = this.stopWaiters;
    this.stopWaiters = [];
    for (const resolve of waiters) resolve(saved);
  }

  /** True when the last recording ended on a failure, so the room offers « partie 2 ». */
  get endedOnFailure(): boolean {
    return this.failed;
  }

  private async openMic() {
    const getUserMedia =
      this.options.getUserMedia ??
      ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
    try {
      // A permission prompt nobody answers must not leave the button spinning.
      const mic = await Promise.race([
        getUserMedia({ audio: true }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('the microphone did not answer within 10 s')), 10_000),
        ),
      ]);
      this.mic = mic;
      for (const track of mic.getAudioTracks()) {
        // A headset unplugged, a device the system took back: the track ends
        // and the teacher's voice would be missing from the rest of the file.
        track.addEventListener('ended', () => this.reopenMic());
      }
    } catch (thrown) {
      // Survivable: a recording of the students alone is still worth having.
      this.mic = null;
      this.issue('micUnavailable', false, errorText(thrown));
    }
  }

  private reopenMic() {
    if (this.state === 'idle' || this.state === 'saving') return;
    const now = Date.now();
    if (now < this.micRetryAt) return;
    this.micRetryAt = now + 5_000;
    void this.openMic().then(() => this.wire());
  }

  /** Every live audio track goes into the mix once; ended ones are let go. */
  private wire() {
    const context = this.context;
    const destination = this.destination;
    if (!context || !destination) return;

    const tracks = [...(this.mic?.getAudioTracks() ?? []), ...this.options.sources.audio()];
    const live = new Set<string>();
    for (const track of tracks) {
      if (track.readyState !== 'live') continue;
      live.add(track.id);
      if (this.wired.has(track.id)) continue;
      try {
        const node = context.createMediaStreamSource(new MediaStream([track]));
        node.connect(destination);
        this.wired.set(track.id, node);
      } catch {
        /* Tried again on the next pass. */
      }
    }
    for (const [id, node] of this.wired) {
      if (live.has(id)) continue;
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
      this.wired.delete(id);
    }
  }

  private draw(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = '#16221f';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    let frame: RecordFrame | null = null;
    try {
      frame = this.options.sources.stage();
    } catch {
      frame = null;
    }
    if (!frame || frame.container.width <= 0 || frame.container.height <= 0) return;

    const scale = Math.min(WIDTH / frame.container.width, HEIGHT / frame.container.height);
    const offsetX = (WIDTH - frame.container.width * scale) / 2;
    const offsetY = (HEIGHT - frame.container.height * scale) / 2;
    const origin = window.location.origin;

    for (const { element, rect } of frame.items) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const info = describe(element);
      const decision = drawDecision(info, origin);
      const boxX = offsetX + (rect.left - frame.container.left) * scale;
      const boxY = offsetY + (rect.top - frame.container.top) * scale;

      if (decision === 'foreign') {
        // Drawing it would taint the canvas and freeze the file for the rest
        // of the class. A plain card stands in, and the teacher is told why.
        this.issue('slidesNotRecorded', false, originOf(info.src));
        ctx.fillStyle = '#22312d';
        ctx.fillRect(boxX, boxY, rect.width * scale, rect.height * scale);
        continue;
      }
      if (decision !== 'draw') continue;

      const w =
        element instanceof HTMLVideoElement
          ? element.videoWidth
          : element instanceof HTMLCanvasElement
            ? element.width
            : element.naturalWidth;
      const h =
        element instanceof HTMLVideoElement
          ? element.videoHeight
          : element instanceof HTMLCanvasElement
            ? element.height
            : element.naturalHeight;
      if (!w || !h) continue;

      // Letterbox inside the element's own box: a slide with its edges cut off
      // is worse than a slide with a margin.
      const itemScale = Math.min(rect.width / w, rect.height / h);
      const dw = w * itemScale * scale;
      const dh = h * itemScale * scale;
      const x = boxX + (rect.width * scale - dw) / 2;
      const y = boxY + (rect.height * scale - dh) / 2;
      try {
        ctx.drawImage(element, x, y, dw, dh);
      } catch {
        // A frame that is not ready yet; the next one will be.
      }
    }
  }

  private cleanup() {
    this.stopTicker?.();
    this.stopTicker = null;
    if (this.rewire) clearInterval(this.rewire);
    this.rewire = null;
    for (const node of this.wired.values()) {
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.wired.clear();
    void this.context?.close().catch(() => {});
    this.context = null;
    this.destination = null;
    this.mic?.getTracks().forEach((track) => track.stop());
    this.mic = null;
    this.videoTrack = null;
    this.recorder = null;
    this.chunks = [];
    this.storeId = null;
  }

  /** The page is going away: save what exists rather than lose it. */
  dispose(): void {
    if (this.state === 'recording' || this.state === 'paused' || this.state === 'starting') {
      void this.stop();
    } else if (this.state === 'idle') {
      this.cleanup();
    }
  }
}
