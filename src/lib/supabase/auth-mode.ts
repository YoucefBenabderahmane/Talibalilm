import { routing } from '@/i18n/routing';

/**
 * Which auth check the middleware makes for a request.
 *
 * The middleware runs on every page view. For a signed-in user, `getUser()`
 * revalidates the JWT against the Auth server — a network round trip on every
 * navigation. `getClaims()` verifies the token locally once the project signs
 * JWTs with an asymmetric key (it falls back to `getUser()` on the legacy
 * symmetric key, so this is preparation, not a change of behaviour, until the
 * signing keys are migrated).
 *
 * The split exists because the two checks trust different things:
 *
 * - `verify` — the server is asked. Used on the pages that decide whether a
 *   signed-in user is allowed to be there (`/login`, `/register`,
 *   `/forgot-password`), where a token for a deleted or banned user must not
 *   be enough to bounce the visitor to `/dashboard` over and over.
 * - `claims` — the token itself is checked, locally where possible. Used
 *   everywhere else; the pages behind `/dashboard` and `/admin` still call
 *   `requireViewer()`/`currentViewer()`, which re-verify with `getUser()`
 *   server-side, so a stale token cannot open anything.
 */
export type AuthMode = 'verify' | 'claims';

/** Paths a signed-in user has no business seeing, and where identity is re-verified. */
const VERIFY_PATHS = ['/login', '/register', '/forgot-password'];

/** Strip a leading `/fr` or `/en` so route matching is locale-agnostic. */
export function withoutLocale(pathname: string): string {
  for (const locale of routing.locales) {
    if (pathname === `/${locale}`) return '/';
    if (pathname.startsWith(`/${locale}/`)) return pathname.slice(locale.length + 1);
  }
  return pathname;
}

function matches(path: string, roots: readonly string[]): boolean {
  return roots.some((p) => path === p || path.startsWith(`${p}/`));
}

/** True for the paths a signed-in visitor is bounced away from. */
export function isAuthOnly(pathname: string): boolean {
  return matches(withoutLocale(pathname), VERIFY_PATHS);
}

/**
 * The check for this path. `/loginx` is NOT `/login`; only the exact path or
 * a child of it counts.
 */
export function authMode(pathname: string): AuthMode {
  return isAuthOnly(pathname) ? 'verify' : 'claims';
}
