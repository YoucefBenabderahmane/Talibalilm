import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { safeNextPath } from '@/lib/auth/next-path';

/**
 * Where every emailed link lands: verification, magic link and password
 * recovery all come back here.
 *
 * Deliberately outside `[locale]` and excluded from the middleware matcher —
 * Supabase redirects to one fixed URL configured in the project, so a
 * locale-prefixed variant would simply never be reached.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  // Never redirect off-origin on the strength of a query parameter.
  const next = safeNextPath(searchParams.get('next'));

  const fail = (reason: string) =>
    NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(reason)}`);

  if (!supabaseConfigured) return fail('unexpected');

  const supabase = await createClient();

  // PKCE flow — signup confirmation, magic link, OAuth.
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return error ? fail('expiredLink') : NextResponse.redirect(`${origin}${next}`);
  }

  // Token-hash flow — the shape Supabase's older email templates send.
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as 'signup' | 'recovery' | 'invite' | 'email_change' | 'magiclink',
      token_hash: tokenHash,
    });
    return error ? fail('expiredLink') : NextResponse.redirect(`${origin}${next}`);
  }

  return fail('expiredLink');
}
