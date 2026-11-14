/**
 * An admin screen's shape while it is being read: a title and a list. The
 * admin shell around it stays where it is between screens, so this is what
 * changes under the office's click until the real screen replaces it.
 */
export default function AdminLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-6">
      <div className="h-8 w-56 animate-pulse rounded bg-line/70" />
      <div className="divide-y divide-line rounded-[var(--radius-card)] border border-line bg-white">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 p-4">
            <div className="h-4 w-1/3 animate-pulse rounded bg-line/50" />
            <div className="h-4 w-1/5 animate-pulse rounded bg-line/40" />
            <div className="ms-auto h-4 w-16 animate-pulse rounded bg-line/40" />
          </div>
        ))}
      </div>
    </div>
  );
}
