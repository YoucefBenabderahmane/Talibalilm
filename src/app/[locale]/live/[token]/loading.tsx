import { Loader2 } from 'lucide-react';

/**
 * The room's dark shell while the session, the deck, the board and the chat
 * are being read. The page's own states (closed, not configured) use the
 * same frame, so nothing jumps when the real one arrives.
 */
export default function LiveRoomLoading() {
  return (
    <main
      aria-busy="true"
      className="flex min-h-dvh items-center justify-center bg-ink px-6 text-center"
    >
      <Loader2 className="size-6 animate-spin text-white/40" aria-hidden="true" />
    </main>
  );
}
