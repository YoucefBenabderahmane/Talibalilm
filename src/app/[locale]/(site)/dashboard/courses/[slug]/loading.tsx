/**
 * The module's home while it is being read: the title block, the progress
 * card and the programme. Painted at once on a click, so the student sees the
 * page coming rather than the dashboard standing still.
 */
export default function CourseHomeLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="hero-wash border-b border-line">
        <div className="shell space-y-4 py-8 sm:py-10">
          <div className="h-3 w-40 animate-pulse rounded bg-line/50" />
          <div className="h-5 w-24 animate-pulse rounded-full bg-line/50" />
          <div className="h-9 w-2/3 animate-pulse rounded bg-line/70" />
          <div className="h-36 max-w-2xl animate-pulse rounded-[var(--radius-card)] bg-white/70" />
        </div>
      </div>
      <div className="shell grid gap-8 py-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="h-96 animate-pulse rounded-[var(--radius-card)] bg-line/40" />
        <div className="h-40 animate-pulse rounded-[var(--radius-card)] bg-line/40" />
      </div>
    </div>
  );
}
