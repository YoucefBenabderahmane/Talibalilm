import { createServerClient } from '@supabase/ssr';
import type { NextRequest, NextResponse } from 'next/server';
import { publicEnv, supabaseConfigured } from '@/lib/env';
import type { AuthMode } from './auth-mode';
import type { Database } from './database.types';

/**
 * Supabase's session cookie, chunked or not: `sb-<ref>-auth-token`, with
 * `.0`, `.1`… appended once it outgrows one cookie.
 */
const AUTH_COOKIE = /^sb-.*-auth-token/;

/**
 * Refresh the auth session on the response the locale middleware already
 * produced, and say who the request belongs to.
 *
 * Supabase access tokens are short-lived; without this the user is silently
 * signed out mid-session. It has to run on the *same* response object that
 * gets returned, or the refreshed cookies never reach the browser.
 *
 * The mode decides how the token is checked (see `auth-mode.ts`):
 * `getUser()` revalidates against the Auth server, `getClaims()` verifies the
 * token locally when the project uses asymmetric signing keys and falls back
 * to the same network call on the legacy symmetric key. Both are called
 * immediately after `createServerClient`, before anything else can read the
 * cookies — `getSession()` inside `getClaims()` is also what rotates them.
 */
export async function refreshSession(
  request: NextRequest,
  response: NextResponse,
  mode: AuthMode,
): Promise<{ userId: string | null }> {
  // Before the Supabase project is connected, the marketing site still has to
  // render. Treat "not configured" as "signed out" rather than throwing.
  if (!supabaseConfigured) return { userId: null };

  // No cookie, no session — and asking Supabase anyway is a network round trip
  // plus a token check on every page view by every visitor and every crawler,
  // none of whom can be signed in. The middleware runs on all of them.
  if (!request.cookies.getAll().some((cookie) => AUTH_COOKIE.test(cookie.name))) {
    return { userId: null };
  }

  const env = publicEnv();

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // verify: the Auth server is asked, exactly as before. Used on the pages
  // that decide whether a signed-in visitor is allowed to be there.
  if (mode === 'verify') {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return { userId: user?.id ?? null };
  }

  // claims: the token is checked locally where the project allows it. A
  // failure is "signed out", the same answer getUser() gives on error. The
  // pages behind /dashboard and /admin re-verify server-side in
  // `requireViewer()`, so a still-valid token for a deleted user opens
  // nothing — it only avoids the round trip for live users.
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return { userId: null };
  return { userId: typeof data.claims.sub === 'string' ? data.claims.sub : null };
}
