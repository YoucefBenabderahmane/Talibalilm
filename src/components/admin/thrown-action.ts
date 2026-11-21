import { unstable_isUnrecognizedActionError } from 'next/navigation';
import type { AdminState } from '@/app/actions/admin';

/**
 * A server action that threw, instead of answering, as an admin screen shows it.
 *
 * An action answers `{ ok: false, error }` for every failure it expects. It
 * THROWS only when it could not run at all — on this site, usually because the
 * page was opened before a new version went live, and the server no longer
 * knows the action the old page calls (Next's `UnrecognizedActionError`).
 * Awaited bare, that rejection reached nobody: the upload simply did not
 * happen, with nothing on screen. Now it is said, with the browser's own words
 * as the detail.
 */
export function thrownAction(error: unknown): AdminState {
  return {
    ok: false,
    error: unstable_isUnrecognizedActionError(error) ? 'pageOutdated' : 'uploadFailed',
    detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
}
