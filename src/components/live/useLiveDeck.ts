'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { classifyUpload } from '@/lib/media/upload-kind';
import {
  LiveDocumentError,
  liveDeckSupported,
  openLiveDocument,
  openLiveImage,
  type LiveDocument,
  type RenderPriority,
} from '@/lib/media/pdf-live';
import {
  forgetSource,
  keepSource,
  purgeOlderThan,
  setRemovedPages,
  sourcesFor,
} from '@/lib/live/deck-store';

/**
 * The teacher's slides, opened on her own machine and shown like Zoom shows
 * them: drawn here, streamed to the class as video.
 *
 * Nothing about the teacher's gestures changes — she drops a PDF on the room or
 * picks it with the panel's button, sees the pages in the panel, and pages
 * through them. What changed is underneath: no conversion of every page, no
 * upload, no signed links to expire. A 500-page deck is ready in about a
 * second, and a page is drawn only when it is needed.
 *
 * The host only. Students never open the file: they receive the page the
 * teacher shows as the room's "slides" video track.
 */

export interface LivePage {
  /** `${sourceId}:${page}` — stable for the life of the deck. */
  id: string;
  sourceId: string;
  page: number;
  filename: string;
}

export type LiveDeckError =
  | { code: 'duplicate'; name: string }
  | { code: 'busy'; name: string }
  | { code: 'convertToPdf' | 'notAnImage'; name: string }
  | { code: 'pdfPassword' | 'pdfCorrupt' | 'pdfEngine' | 'pdfEmpty'; name: string; detail?: string }
  | { code: 'pageFailed'; name: string; detail?: string };

interface Source {
  id: string;
  name: string;
  fingerprint: string;
  doc: LiveDocument;
  removed: Set<number>;
}

/** The slide the class sees: a 1080p box. Thumbnails: a 320×180 box. */
export const STAGE_BOX = { width: 1920, height: 1080 } as const;
const THUMB_BOX = { width: 320, height: 180 } as const;
const STAGE_CACHE = 8;
const THUMB_CACHE = 160;
/** A deck from a class two weeks ago is not restored, and not kept on disk. */
const KEEP_MS = 14 * 24 * 3600 * 1000;

const fingerprintOf = (file: File) => `${file.name}|${file.size}|${file.lastModified}`;

/** A bounded cache of bitmaps; an evicted one is released at once. */
class BitmapCache {
  private readonly entries = new Map<string, ImageBitmap>();
  constructor(private readonly limit: number) {}
  get(key: string): ImageBitmap | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }
  set(key: string, bitmap: ImageBitmap) {
    this.entries.get(key)?.close();
    this.entries.delete(key);
    this.entries.set(key, bitmap);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.get(oldest)?.close();
      this.entries.delete(oldest);
    }
  }
  dropSource(sourceId: string) {
    for (const [key, bitmap] of this.entries) {
      if (key.startsWith(`${sourceId}:`)) {
        bitmap.close();
        this.entries.delete(key);
      }
    }
  }
  clear() {
    for (const bitmap of this.entries.values()) bitmap.close();
    this.entries.clear();
  }
}

export function useLiveDeck(sessionId: string, enabled: boolean) {
  const [supported, setSupported] = useState(false);
  const [pages, setPages] = useState<LivePage[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<LiveDeckError | null>(null);
  /** The deck works, but this browser would not keep a copy: no restore after a reload. */
  const [notice, setNotice] = useState<'notKept' | null>(null);
  /** The deck kept from before a reload has been reopened (or there was none). */
  const [restored, setRestored] = useState(false);

  const sources = useRef(new Map<string, Source>());
  const pagesRef = useRef<LivePage[]>([]);
  const stageCache = useRef(new BitmapCache(STAGE_CACHE));
  const thumbCache = useRef(new BitmapCache(THUMB_CACHE));
  const inFlight = useRef(new Map<string, Promise<ImageBitmap | null>>());
  const openingRef = useRef<string | null>(null);

  // Decided after mount: the server has no OffscreenCanvas to ask.
  useEffect(() => {
    setSupported(enabled && liveDeckSupported());
  }, [enabled]);

  const publish = useCallback((next: LivePage[]) => {
    pagesRef.current = next;
    setPages(next);
  }, []);

  const rebuild = useCallback(() => {
    const next: LivePage[] = [];
    for (const source of sources.current.values()) {
      for (let page = 1; page <= source.doc.pages; page++) {
        if (source.removed.has(page)) continue;
        next.push({ id: `${source.id}:${page}`, sourceId: source.id, page, filename: source.name });
      }
    }
    publish(next);
    return next;
  }, [publish]);

  const openOne = useCallback(async (file: File, id: string): Promise<Source> => {
    const kind = classifyUpload(file);
    const doc = kind === 'pdf' ? await openLiveDocument(file) : await openLiveImage(file);
    return { id, name: file.name, fingerprint: fingerprintOf(file), doc, removed: new Set() };
  }, []);

  // The deck this class had before a reload comes back by itself.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void (async () => {
      await purgeOlderThan(KEEP_MS);
      const stored = await sourcesFor(sessionId);
      for (const row of stored) {
        if (cancelled) return;
        try {
          const file = new File([row.file], row.name, { type: row.type });
          const source = await openOne(file, row.sourceId);
          for (const page of row.removed) source.removed.add(page);
          if (cancelled) {
            source.doc.close();
            return;
          }
          sources.current.set(source.id, source);
          rebuild();
        } catch {
          // A file the browser can no longer open is dropped from the restore.
          await forgetSource(sessionId, row.sourceId);
        }
      }
      if (!cancelled) setRestored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, sessionId, openOne, rebuild]);

  // Leaving the room frees the workers and the bitmaps.
  useEffect(
    () => () => {
      for (const source of sources.current.values()) source.doc.close();
      sources.current.clear();
      stageCache.current.clear();
      thumbCache.current.clear();
    },
    [],
  );

  /**
   * Open dropped files. Resolves with the live index of the first new page, or
   * null when nothing was added. Refuses a file already open, and a drop while
   * another file is still opening — the duplicate decks the teacher used to get.
   */
  const open = useCallback(
    async (files: FileList | File[]): Promise<number | null> => {
      setError(null);
      const list = Array.from(files);
      if (openingRef.current) {
        setError({ code: 'busy', name: openingRef.current });
        return null;
      }

      let firstNew: number | null = null;
      for (const file of list) {
        const kind = classifyUpload(file);
        if (kind === 'office') {
          setError({ code: 'convertToPdf', name: file.name });
          continue;
        }
        if (kind === 'unsupported') {
          setError({ code: 'notAnImage', name: file.name });
          continue;
        }
        const fingerprint = fingerprintOf(file);
        const already = Array.from(sources.current.values()).find((s) => s.fingerprint === fingerprint);
        if (already) {
          setError({ code: 'duplicate', name: file.name });
          continue;
        }

        openingRef.current = file.name;
        setOpening(file.name);
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        try {
          const source = await openOne(file, id);
          if (source.doc.pages === 0) {
            source.doc.close();
            setError({ code: 'pdfEmpty', name: file.name });
            continue;
          }
          const before = pagesRef.current.length;
          sources.current.set(id, source);
          rebuild();
          firstNew ??= before;
          void keepSource(sessionId, id, file).then((kept) => {
            if (!kept) setNotice('notKept');
          });
        } catch (thrown) {
          const detail =
            thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
          const reason = thrown instanceof LiveDocumentError ? thrown.reason : 'engine';
          setError({
            code: reason === 'password' ? 'pdfPassword' : reason === 'corrupt' ? 'pdfCorrupt' : 'pdfEngine',
            name: file.name,
            detail,
          });
        } finally {
          openingRef.current = null;
          setOpening(null);
        }
      }
      return firstNew;
    },
    [openOne, rebuild, sessionId],
  );

  /** A page as a bitmap, for the stage (1080p) or a thumbnail. Cached. */
  const render = useCallback(
    async (pageId: string, size: 'stage' | 'thumb', priority: RenderPriority) => {
      const [sourceId, pageText] = pageId.split(':');
      const source = sources.current.get(sourceId ?? '');
      const page = Number(pageText);
      if (!source || !Number.isFinite(page)) return null;

      const cache = size === 'stage' ? stageCache.current : thumbCache.current;
      const key = `${pageId}@${size}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const running = inFlight.current.get(key);
      if (running) return running;

      const box = size === 'stage' ? STAGE_BOX : THUMB_BOX;
      const job = source.doc
        .render(page, box.width, box.height, priority)
        .then((bitmap) => {
          if (bitmap) cache.set(key, bitmap);
          else if (size === 'stage') setError({ code: 'pageFailed', name: source.name });
          return bitmap;
        })
        .catch((thrown: unknown) => {
          if (size === 'stage') {
            setError({
              code: 'pageFailed',
              name: source.name,
              detail: thrown instanceof Error ? thrown.message : String(thrown),
            });
          }
          return null;
        })
        .finally(() => inFlight.current.delete(key));
      inFlight.current.set(key, job);
      return job;
    },
    [],
  );

  const remove = useCallback(
    (pageId: string) => {
      const [sourceId, pageText] = pageId.split(':');
      const source = sources.current.get(sourceId ?? '');
      if (!source) return;
      source.removed.add(Number(pageText));
      if (source.removed.size >= source.doc.pages) {
        source.doc.close();
        sources.current.delete(source.id);
        stageCache.current.dropSource(source.id);
        thumbCache.current.dropSource(source.id);
        void forgetSource(sessionId, source.id);
      } else {
        void setRemovedPages(sessionId, source.id, Array.from(source.removed));
      }
      rebuild();
    },
    [rebuild, sessionId],
  );

  /** The pages as they are now — newer than `pages` until the next render. */
  const current = useCallback(() => pagesRef.current, []);

  const clear = useCallback(() => {
    for (const source of sources.current.values()) {
      source.doc.close();
      void forgetSource(sessionId, source.id);
    }
    sources.current.clear();
    stageCache.current.clear();
    thumbCache.current.clear();
    publish([]);
  }, [publish, sessionId]);

  return {
    supported,
    pages,
    current,
    restored,
    opening,
    error,
    notice,
    dismissError: () => setError(null),
    open,
    render,
    remove,
    clear,
  };
}

export type LiveDeck = ReturnType<typeof useLiveDeck>;
