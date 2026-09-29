import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { sameOrigin } from '@/lib/http/same-origin';
import { reportError } from '@/lib/observability/report';

export const dynamic = 'force-dynamic';

/**
 * One chat line, persisted.
 *
 * A route handler rather than a Server Action: the room already showed the
 * line over LiveKit, and an action would rebuild the whole classroom on the
 * server just to say "saved". A class of thirty talking is thirty of those a
 * minute.
 *
 * The insert policy is the gate: a student may speak only as themselves, only
 * in a room they can enter, and only while chat is open. The session id is
 * read from the cookie without a network round trip, and the database compares
 * it with the token it already verified.
 *
 * A student can reach this, so a failure says only that it failed; the cause
 * goes to `reportError` where somebody can act on it.
 */


const schema = z.object({
  sessionId: z.string().uuid(),
  body: z.string().trim().min(1).max(2000),
});

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 403 });
  }
  if (!supabaseConfigured) {
    return NextResponse.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: 'notAdmin' }, { status: 401 });
  }

  const { error } = await supabase.from('live_messages').insert({
    session_id: parsed.data.sessionId,
    user_id: session.user.id,
    body: parsed.data.body,
  });

  if (error) {
    reportError('live.message', error, { sessionId: parsed.data.sessionId });
    return NextResponse.json({ ok: false, error: 'saveFailed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
