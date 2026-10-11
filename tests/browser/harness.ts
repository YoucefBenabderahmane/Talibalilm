/**
 * The real recorder, mounted on a bare page for the browser tests.
 *
 * Bundled by the spec with esbuild from the same source the classroom ships,
 * so these tests exercise `RecordingSession` itself — not a copy of it. The
 * page mimics the room's stage: a container marked `data-record-container` and
 * the camera as a `data-record` video; slides are added as images on demand.
 */
import { openChunkStore } from '@/lib/live/recording/chunk-store';
import {
  RecordingSession,
  type RecorderIssue,
  type RecorderState,
} from '@/lib/live/recording/session';

interface Saved {
  bytes: number;
  filename: string;
  url: string;
}

interface Harness {
  ready: boolean;
  states: RecorderState[];
  issues: RecorderIssue[];
  saved: Saved[];
  chunks: { at: number; bytes: number }[];
  recorderConstructions: number;
  micRequests: number;
  setup(): Promise<void>;
  start(options?: { micDelayMs?: number; withStore?: boolean; realDownload?: boolean }): Promise<void>;
  /** What « Quitter » does: stop, wait for the save, then navigate away. */
  stopAndLeave(): Promise<void>;
  startTwiceQuickly(): Promise<void>;
  stopWhileStarting(): Promise<RecorderState>;
  pause(): boolean;
  resume(): boolean;
  stop(): Promise<boolean>;
  failRecorder(message: string): void;
  loseMic(): void;
  addSlide(src: string, cors: boolean): Promise<void>;
  videoMuted(): boolean | null;
  duration(url: string): Promise<number>;
  pending(): Promise<{ id: string; chunks: number; bytes: number }[]>;
  recover(id: string): Promise<{ bytes: number; url: string } | null>;
}

declare global {
  interface Window {
    harness: Harness;
  }
}

let session: RecordingSession | null = null;
let camera: MediaStream | null = null;

// Count every MediaRecorder the code creates: two would mean a double start.
const NativeRecorder = window.MediaRecorder;
class CountingRecorder extends NativeRecorder {
  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    super(stream, options);
    window.harness.recorderConstructions++;
    this.addEventListener('dataavailable', (event) => {
      window.harness.chunks.push({ at: Date.now(), bytes: (event as BlobEvent).data.size });
    });
  }
}
window.MediaRecorder = CountingRecorder as typeof MediaRecorder;

function stage() {
  const container = document.querySelector<HTMLElement>('[data-record-container]');
  if (!container) return null;
  const items = Array.from(container.querySelectorAll<HTMLElement>('[data-record]')).map(
    (element) => ({
      element: element as HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
      rect: element.getBoundingClientRect(),
    }),
  );
  return items.length ? { container: container.getBoundingClientRect(), items } : null;
}

function make(options: { micDelayMs?: number; withStore?: boolean; realDownload?: boolean }, store: Awaited<ReturnType<typeof openChunkStore>>) {
  return new RecordingSession({
    fileName: 'cours-test',
    sources: { stage, audio: () => camera?.getAudioTracks() ?? [] },
    store: options.withStore === false ? null : store,
    getUserMedia: async (constraints) => {
      window.harness.micRequests++;
      if (options.micDelayMs) await new Promise((r) => setTimeout(r, options.micDelayMs));
      return navigator.mediaDevices.getUserMedia(constraints);
    },
    onState: (state) => window.harness.states.push(state),
    onIssue: (issue) => window.harness.issues.push(issue),
    ...(options.realDownload
      ? {}
      : {
          onSaved: ({ blob, filename }: { blob: Blob; filename: string }) =>
            window.harness.saved.push({ bytes: blob.size, filename, url: URL.createObjectURL(blob) }),
        }),
  });
}

window.harness = {
  ready: false,
  states: [],
  issues: [],
  saved: [],
  chunks: [],
  recorderConstructions: 0,
  micRequests: 0,

  async setup() {
    camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const video = document.querySelector<HTMLVideoElement>('video[data-record]')!;
    video.srcObject = camera;
    await video.play().catch(() => {});
    await new Promise<void>((resolve) => {
      const check = () => (video.videoWidth > 0 ? resolve() : setTimeout(check, 50));
      check();
    });
    window.harness.ready = true;
  },

  async start(options = {}) {
    session = make(options, await openChunkStore());
    await session.start();
  },

  async startTwiceQuickly() {
    session = make({}, await openChunkStore());
    const first = session.start();
    const second = session.start();
    await Promise.all([first, second]);
  },

  async stopWhileStarting() {
    session = make({ micDelayMs: 1500 }, await openChunkStore());
    const starting = session.start();
    await new Promise((r) => setTimeout(r, 200));
    await session.stop();
    await starting;
    return session.current;
  },

  async stopAndLeave() {
    await session?.stop();
    window.location.assign('about:blank');
  },

  pause: () => session?.pause() ?? false,
  resume: () => session?.resume() ?? false,
  stop: () => session?.stop() ?? Promise.resolve(false),

  failRecorder(message) {
    const recorder = session?.mediaRecorder;
    if (!recorder) throw new Error('no recorder');
    const event = new Event('error') as Event & { error: DOMException };
    Object.defineProperty(event, 'error', { value: new DOMException(message, 'UnknownError') });
    recorder.dispatchEvent(event);
  },

  loseMic() {
    // What the browser does when a headset is unplugged: the track ends.
    const mic = (session as unknown as { mic: MediaStream | null })?.mic;
    const track = mic?.getAudioTracks()[0];
    if (!track) throw new Error('no mic');
    track.stop();
    track.dispatchEvent(new Event('ended'));
  },

  async addSlide(src, cors) {
    const img = document.createElement('img');
    img.setAttribute('data-record', 'main');
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain';
    if (cors) img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('slide failed to load'));
      img.src = src;
      document.querySelector('[data-record-container]')!.appendChild(img);
    });
  },

  videoMuted() {
    const track = session?.mediaRecorder?.stream.getVideoTracks()[0];
    return track ? track.muted : null;
  },

  async duration(url) {
    // Chrome writes WebM without a duration header; seeking to the end makes
    // the browser compute the real one.
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;
    await new Promise((r) => (video.onloadedmetadata = r));
    video.currentTime = 1e9;
    await new Promise((r) => (video.ontimeupdate = r));
    return video.duration;
  },

  async pending() {
    const store = await openChunkStore();
    const rows = (await store?.pending()) ?? [];
    return rows.map((r) => ({ id: r.id, chunks: r.chunks, bytes: r.bytes }));
  },

  async recover(id) {
    const store = await openChunkStore();
    const blob = await store?.assemble(id);
    return blob ? { bytes: blob.size, url: URL.createObjectURL(blob) } : null;
  },
};

void window.harness.setup();
