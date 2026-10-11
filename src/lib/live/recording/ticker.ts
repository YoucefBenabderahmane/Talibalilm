/**
 * A frame clock that keeps going when the tab is not in front.
 *
 * The recorder paints the stage onto its canvas once per tick. It used
 * `requestAnimationFrame`, which the browser stops entirely for a hidden tab or
 * a covered window — so a teacher who opened PowerPoint, or another tab, got a
 * recording frozen for exactly that stretch. Timers on the page itself are
 * throttled too. A dedicated worker's timer is not, and its message is an
 * ordinary task on the page, so the paint still happens.
 *
 * If a worker cannot be made (a locked-down browser, a CSP that refuses blob
 * workers), it falls back to animation frames: the old behaviour, which is a
 * worse clock but still a clock.
 */
export function startTicker(fps: number, onTick: () => void): () => void {
  const interval = Math.max(1, Math.round(1000 / fps));

  if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined') {
    try {
      const source = `const id = setInterval(() => postMessage(0), ${interval});
onmessage = () => { clearInterval(id); close(); };`;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = () => onTick();
      return () => {
        worker.postMessage('stop');
        worker.terminate();
      };
    } catch {
      // Fall through to animation frames.
    }
  }

  let frame = 0;
  const loop = () => {
    frame = requestAnimationFrame(loop);
    onTick();
  };
  frame = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(frame);
}
