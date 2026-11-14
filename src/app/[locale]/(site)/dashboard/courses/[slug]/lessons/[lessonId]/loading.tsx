/**
 * The lesson page's shape while its content is being read: the title block,
 * the player's box, and the syllabus column. Painted at once on a click so
 * the student sees the page coming rather than the previous one standing
 * still; the real lesson streams in over it.
 */
export default function LessonLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="shell grid gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:py-14"
    >
      <div className="min-w-0 space-y-4">
        <div className="h-3 w-48 animate-pulse rounded bg-line/50" />
        <div className="h-5 w-24 animate-pulse rounded-full bg-line/50" />
        <div className="h-9 w-3/4 animate-pulse rounded bg-line/70" />
        <div className="mt-6 aspect-video w-full animate-pulse rounded-[var(--radius-card)] bg-line/40" />
        <div className="space-y-2 pt-4">
          <div className="h-4 w-full animate-pulse rounded bg-line/40" />
          <div className="h-4 w-11/12 animate-pulse rounded bg-line/40" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-line/40" />
        </div>
      </div>
      <div className="h-80 animate-pulse rounded-[var(--radius-card)] bg-line/40" />
    </div>
  );
}
