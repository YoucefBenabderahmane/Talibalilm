'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  openChunkStore,
  type ChunkStore,
  type StoredRecording,
} from '@/lib/live/recording/chunk-store';
import {
  RecordingSession,
  type RecordSources,
  type RecorderIssue,
  type RecorderState,
} from '@/lib/live/recording/session';

export type { RecorderState, RecordSources, RecorderIssue };
export type { RecordFrame, RecordFrameItem } from '@/lib/live/recording/session';

/**
 * Record the class to the teacher's own machine.
 *
 * The lifecycle lives in `RecordingSession` (framework-free, tested in a real
 * browser); this hook only turns it into React state. What it adds on top:
 * the « partie 2 » numbering after a failure, the list of recordings a crash
 * left on disk, and a promise to wait on before leaving the room.
 *
 * Nothing is uploaded. The file is handed to the browser's downloader, and the
 * school puts it on YouTube or Drive themselves — the workflow they already had.
 */
interface Recorder {
  state: RecorderState;
  /** The latest problem that stopped or refused something, with the browser's own words. */
  issue: RecorderIssue | null;
  /** Warnings that stay true for the whole recording (slides not recorded…). */
  warnings: RecorderIssue[];
  seconds: number;
  /** 1 for the first file of the class; 2+ after a failure saved part one. */
  part: number;
  start: () => Promise<void>;
  /** Stops and saves. Resolves once the file is handed over. */
  stop: () => Promise<boolean>;
  togglePause: () => void;
  dismissIssue: () => void;
  /** Recordings a crash or a closed tab left on disk, never downloaded. */
  recovered: StoredRecording[];
  downloadRecovered: (id: string) => Promise<void>;
  discardRecovered: (id: string) => Promise<void>;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function useRecorder(fileBaseName: string, sources: RecordSources): Recorder {
  const [state, setState] = useState<RecorderState>('idle');
  const [issue, setIssue] = useState<RecorderIssue | null>(null);
  const [warnings, setWarnings] = useState<RecorderIssue[]>([]);
  const [seconds, setSeconds] = useState(0);
  const [part, setPart] = useState(1);
  const [recovered, setRecovered] = useState<StoredRecording[]>([]);

  const sessionRef = useRef<RecordingSession | null>(null);
  const storeRef = useRef<Promise<ChunkStore | null> | null>(null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const partRef = useRef(part);
  partRef.current = part;

  const store = useCallback(() => {
    storeRef.current ??= openChunkStore();
    return storeRef.current;
  }, []);

  // What a crash left behind, offered once when the room opens. Files already
  // downloaded are cleared after a week so the disk does not fill with lessons.
  useEffect(() => {
    let cancelled = false;
    void store().then(async (s) => {
      if (!s) return;
      await s.purgeSaved(7 * 24 * 3600 * 1000);
      const pending = await s.pending();
      if (!cancelled) setRecovered(pending);
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  // The on-screen counter reads the session's own clock, so a throttled timer
  // in a background tab cannot make it drift from the file.
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;
    const id = setInterval(() => setSeconds(sessionRef.current?.elapsedSeconds() ?? 0), 1000);
    return () => clearInterval(id);
  }, [state]);

  // Leaving the room by any route other than the buttons (a link, the back
  // button) still saves the file rather than dropping it.
  useEffect(() => () => sessionRef.current?.dispose(), []);

  const start = useCallback(async () => {
    if (sessionRef.current && sessionRef.current.current !== 'idle') return;
    setIssue(null);
    setWarnings([]);
    setSeconds(0);
    const currentPart = partRef.current;
    const session: RecordingSession = new RecordingSession({
      fileName: currentPart > 1 ? `${fileBaseName}-partie-${currentPart}` : fileBaseName,
      sources: {
        stage: () => sourcesRef.current.stage(),
        audio: () => sourcesRef.current.audio(),
      },
      store: await store(),
      onState: (next) => {
        setState(next);
        // A file that ended on a failure is part one of a lesson that goes on:
        // the next « Enregistrer » writes « partie 2 », not a duplicate name.
        if (next === 'idle' && session.endedOnFailure) setPart((n) => n + 1);
      },
      onIssue: (found) => {
        if (found.fatal) setIssue(found);
        else
          setWarnings((list) =>
            list.some((w) => w.code === found.code) ? list : [...list, found],
          );
      },
    });
    sessionRef.current = session;
    await session.start();
  }, [fileBaseName, store]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return false;
    return session.stop();
  }, []);

  const togglePause = useCallback(() => {
    sessionRef.current?.togglePause();
  }, []);

  const downloadRecovered = useCallback(
    async (id: string) => {
      const s = await store();
      const row = recovered.find((r) => r.id === id);
      if (!s || !row) return;
      const blob = await s.assemble(id);
      if (!blob) return;
      const extension = row.mimeType.includes('mp4') ? 'mp4' : 'webm';
      download(blob, `${row.name}-recupere.${extension}`);
      await s.markSaved(id);
      setRecovered((list) => list.filter((r) => r.id !== id));
    },
    [recovered, store],
  );

  const discardRecovered = useCallback(
    async (id: string) => {
      const s = await store();
      await s?.remove(id);
      setRecovered((list) => list.filter((r) => r.id !== id));
    },
    [store],
  );

  const dismissIssue = useCallback(() => setIssue(null), []);

  return {
    state,
    issue,
    warnings,
    seconds,
    part,
    start,
    stop,
    togglePause,
    dismissIssue,
    recovered,
    downloadRecovered,
    discardRecovered,
  };
}
