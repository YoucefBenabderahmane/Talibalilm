'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Record the class to the teacher's own machine.
 *
 * It used to ask which screen to capture, because the room was a cross-origin
 * iframe and `MediaRecorder` could not reach inside it — `getDisplayMedia` was
 * the only way in. The room is ours now, so the picker is gone: recording
 * starts on the class itself, with no dialogue and nothing for the teacher to
 * choose in front of forty waiting students.
 *
 * What it records is whatever is on the stage — the teacher's camera, or the
 * shared screen, or the slide — drawn onto a canvas at 30fps, with every
 * audio track in the room mixed underneath. Tracks that appear mid-lesson are
 * picked up: a student unmuted ten minutes in is in the recording.
 *
 * Nothing is uploaded. The file is handed to the browser's downloader, and the
 * school puts it on YouTube or Drive themselves and pastes the link onto the
 * lesson — the workflow they already had.
 */
export type RecorderState = 'idle' | 'starting' | 'recording' | 'paused' | 'saving';

/** One drawable element of the stage, and where it sits inside the stage box. */
export interface RecordFrameItem {
  element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;
  rect: DOMRect;
}

export interface RecordFrame {
  /** The stage box the recording is framed on. */
  container: DOMRect;
  /** What is inside it, in paint order. */
  items: RecordFrameItem[];
}

export interface RecordSources {
  /**
   * What the stage is showing right now, and where. A reduced screen share is
   * an item like any other, so the recording keeps it in its corner.
   */
  stage: () => RecordFrame | null;
  /** Every audio track worth capturing — the local mic and each participant. */
  audio: () => MediaStreamTrack[];
}

interface Recorder {
  state: RecorderState;
  error: string | null;
  seconds: number;
  start: () => Promise<void>;
  stop: () => void;
  togglePause: () => void;
}

const WIDTH = 1280;
const HEIGHT = 720;

function pickMimeType(): string | undefined {
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

export function useRecorder(fileBaseName: string, sources: RecordSources): Recorder {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameRef = useRef<number | null>(null);
  const audioRef = useRef<{
    context: AudioContext;
    destination: MediaStreamAudioDestinationNode;
  } | null>(null);
  const wiredRef = useRef<Set<string>>(new Set());
  const micRef = useRef<MediaStream | null>(null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const cleanup = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    tickRef.current = null;
    frameRef.current = null;
    audioRef.current?.context.close().catch(() => {});
    audioRef.current = null;
    wiredRef.current.clear();
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    if (typeof MediaRecorder === 'undefined' || typeof document === 'undefined') {
      setError('unsupported');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.captureStream !== 'function') {
      setError('unsupported');
      return;
    }

    // Audio. The teacher's own microphone is captured separately because a
    // browser does not play your own voice back to you, so it is in no track
    // the room is already carrying — without this the lesson has everyone in it
    // except the person teaching.
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new Ctor();
    const destination = context.createMediaStreamDestination();
    audioRef.current = { context, destination };

    // Acknowledged before the first await: `getUserMedia` can take a moment,
    // and a button that shows nothing while a deck is converting reads as
    // broken rather than busy.
    setState('starting');
    try {
      micRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // A refusal is survivable: a recording of the students alone is still
      // worth having, and this must not be why the class is not recorded.
      micRef.current = null;
    }

    const wire = () => {
      const tracks = [...(micRef.current?.getAudioTracks() ?? []), ...sourcesRef.current.audio()];
      for (const track of tracks) {
        if (wiredRef.current.has(track.id) || track.readyState !== 'live') continue;
        wiredRef.current.add(track.id);
        try {
          context.createMediaStreamSource(new MediaStream([track])).connect(destination);
        } catch {
          wiredRef.current.delete(track.id);
        }
      }
    };
    wire();
    // Someone who unmutes ten minutes in belongs in the recording too.
    const rewire = setInterval(wire, 2000);

    const draw = () => {
      frameRef.current = requestAnimationFrame(draw);
      const frame = sourcesRef.current.stage();
      ctx.fillStyle = '#16221f';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      if (!frame || frame.container.width <= 0 || frame.container.height <= 0) return;

      // The stage box maps onto the 1280x720 frame, and everything inside keeps
      // its place in it — so the reduced share is recorded in its corner,
      // exactly where the class saw it.
      const scale = Math.min(WIDTH / frame.container.width, HEIGHT / frame.container.height);
      const offsetX = (WIDTH - frame.container.width * scale) / 2;
      const offsetY = (HEIGHT - frame.container.height * scale) / 2;

      for (const { element, rect } of frame.items) {
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
        if (!w || !h || rect.width <= 0 || rect.height <= 0) continue;

        // Letterbox rather than crop, inside the element's own box: a slide
        // with its edges cut off is worse than a slide with a margin.
        const itemScale = Math.min(rect.width / w, rect.height / h);
        const dw = w * itemScale;
        const dh = h * itemScale;
        const x = offsetX + (rect.left - frame.container.left) * scale + (rect.width * scale - dw) / 2;
        const y = offsetY + (rect.top - frame.container.top) * scale + (rect.height * scale - dh) / 2;
        try {
          ctx.drawImage(element, x, y, dw, dh);
        } catch {
          // A frame that is not ready yet; the next one will be.
        }
      }
    };
    draw();

    const stream = new MediaStream([
      ...canvas.captureStream(30).getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ]);

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      clearInterval(rewire);
      cleanup();
      setError('unsupported');
      setState('idle');
      return;
    }

    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    recorder.onstop = () => {
      clearInterval(rewire);
      setState('saving');
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' });
      const extension = (recorder.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = `${fileBaseName}.${extension}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoked on a timer: Safari has been known to abandon the download if
      // the URL dies in the same tick as the click.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);

      chunksRef.current = [];
      cleanup();
      setState('idle');
      setSeconds(0);
    };

    recorderRef.current = recorder;
    try {
      // Chunks as it goes, so a crash costs seconds rather than the whole lesson.
      recorder.start(5_000);
    } catch {
      cleanup();
      setError('unsupported');
      setState('idle');
      return;
    }
    setState('recording');
    setSeconds(0);
    tickRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  }, [cleanup, fileBaseName]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    // A paused recorder still has to be stopped to flush its file.
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else cleanup();
  }, [cleanup]);

  /**
   * Pause without ending the file.
   *
   * A break, or a private word with a student. `MediaRecorder` pauses natively,
   * so both halves end up in one file rather than leaving the school two to
   * join. The timer stops with it, so the duration on screen is the length of
   * the recording and not the time since it began.
   */
  const togglePause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;

    if (recorder.state === 'recording') {
      recorder.pause();
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
      setState('paused');
    } else if (recorder.state === 'paused') {
      recorder.resume();
      tickRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      setState('recording');
    }
  }, []);

  return { state, error, seconds, start, stop, togglePause };
}
