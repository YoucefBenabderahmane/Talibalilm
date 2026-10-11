'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * One page of the live deck in the slides panel, drawn only once it scrolls
 * into view. A 500-page deck is 500 list items and a handful of drawings — the
 * pages nobody scrolls to are never rendered.
 */
export function LiveThumb({
  pageId,
  render,
}: {
  pageId: string;
  render: (pageId: string) => Promise<ImageBitmap | null>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void render(pageId).then((bitmap) => {
      const element = canvas.current;
      if (cancelled || !bitmap || !element) return;
      element.width = bitmap.width;
      element.height = bitmap.height;
      try {
        element.getContext('2d')?.drawImage(bitmap, 0, 0);
      } catch {
        /* Released by the cache in between; the next scroll redraws it. */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [visible, pageId, render]);

  return <canvas ref={canvas} className="absolute inset-0 size-full object-contain" />;
}
