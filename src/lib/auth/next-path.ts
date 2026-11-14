/**
 * The one place a `?next=` parameter is turned into somewhere to go.
 *
 * Three screens used to check `startsWith('/') && !startsWith('//')`, which
 * lets `/\evil.com` through: browsers read a backslash as a slash in an
 * http(s) URL, so the redirect lands on `//evil.com` — another site, reached
 * from a link that began on ours. That is an open redirect, and a login page
 * with one is a phishing kit.
 *
 * Same-origin paths only, decided by the URL parser rather than by string
 * prefixes: the candidate is resolved against a throwaway origin, and anything
 * that changes the origin, carries credentials, or hides a backslash or a
 * control character is replaced by the fallback. Pure, so the login form can
 * use it in the browser and the server action can use it again.
 */
export function safeNextPath(raw: string | null | undefined, fallback = '/dashboard'): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return fallback;
  // A path, not a scheme-relative URL (`//host`) and not its backslash twin.
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return fallback;
  // No backslashes anywhere, no whitespace, no control characters: every one
  // of them is something a parser somewhere treats specially.
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return fallback;

  try {
    const probe = new URL(raw, 'https://next.invalid');
    if (probe.origin !== 'https://next.invalid') return fallback;
    if (probe.username || probe.password) return fallback;
    if (!probe.pathname.startsWith('/')) return fallback;
  } catch {
    return fallback;
  }

  return raw;
}
