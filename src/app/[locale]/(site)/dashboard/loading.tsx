/**
 * What the dashboard looks like while its reads are in flight.
 *
 * There was no loading state anywhere under the dashboard, so a click showed
 * nothing until the whole server render had finished — "every click waits",
 * as the teacher put it. A skeleton in the page's own shape is painted at
 * once, and the real page replaces it as soon as it streams in.
 */
export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <section className="hero-wash border-b border-line">
        <div className="shell py-10 sm:py-12">
          <div className="flex flex-col items-center gap-6 sm:flex-row">
            <div className="size-20 animate-pulse rounded-full bg-line/70" />
            <div className="min-w-0 flex-1 space-y-3">
              <div className="h-7 w-56 max-w-full animate-pulse rounded bg-line/70" />
              <div className="h-4 w-40 max-w-full animate-pulse rounded bg-line/50" />
              <div className="flex gap-2">
                <div className="h-6 w-24 animate-pulse rounded-full bg-line/50" />
                <div className="h-6 w-32 animate-pulse rounded-full bg-line/50" />
              </div>
            </div>
          </div>
        </div>
      </section>
      <div className="shell grid gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <div className="h-6 w-48 animate-pulse rounded bg-line/70" />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="h-40 animate-pulse rounded-[var(--radius-card)] bg-line/40" />
            <div className="h-40 animate-pulse rounded-[var(--radius-card)] bg-line/40" />
          </div>
        </div>
        <div className="h-64 animate-pulse rounded-[var(--radius-card)] bg-line/40" />
      </div>
    </div>
  );
}
