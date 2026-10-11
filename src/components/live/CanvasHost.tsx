'use client';

import { useEffect, useRef } from 'react';

/**
 * Puts an existing canvas element into the page, without React owning it.
 *
 * The live deck's canvas is streamed to the class: a captured stream belongs
 * to the element it came from, so the element must outlive every re-render and
 * every switch to the board and back. React would create a new one each time
 * it mounted the stage; this host only lends it a place on the screen.
 */
export function CanvasHost({ canvas }: { canvas: HTMLCanvasElement | null }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element || !canvas) return;
    element.appendChild(canvas);
    return () => {
      if (canvas.parentNode === element) element.removeChild(canvas);
    };
  }, [canvas]);
  return <div ref={host} className="flex size-full items-center justify-center" />;
}
