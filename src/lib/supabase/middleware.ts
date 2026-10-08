import { createServerClient } from '@supabase/ssr';
import type { NextRequest, NextResponse } from 'next/server';
import { publicEnv, supabaseConfigured } from '@/lib/env';
import type { Database } from './database.types';

/**
 * Supabase's session cookie, chunked or not: `sb-<ref>-auth-token`, with
 * `.0`, `.1`… appended once it outgrows one cookie.
 */
const AUTH_COOKIE = /^sb-.*-auth-token/;

/**
 * Refresh the auth session on the response the locale middleware already
 * produced.
 *
 * Supabase access tokens are short-lived; without this the user is silently
 * signed out mid-session. It has to run on the *same* response object that
 * gets returned, or the refreshed cookies never reach the browser.
 *
 * Returns the user so the caller can gate routes without a second round trip.
 */
export async function refreshSession(
  request: NextRequest,
  response: NextResponse,
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

  // getUser(), not getSession(): getSession() trusts the cookie as-is, while
  // getUser() revalidates the JWT against the auth server. In middleware,
  // which is what protected routes lean on, the difference is the whole
  // security guarantee.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { userId: user?.id ?? null };
}
