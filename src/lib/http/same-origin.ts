import type { NextRequest } from 'next/server';

/**
 * Is this request from one of our own pages?
 *
 * A route handler that writes does not get the origin check a Server Action
 * gets for free. The cookie is the thing worth protecting, and a browser only
 * attaches it to a request from this site — so a request that arrives with
 * another site's Origin, or with none at all, is refused rather than assumed
 * harmless. `fetch` sends Origin on every POST, same-origin included.
 */
export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}
