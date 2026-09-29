import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { sameOrigin } from '@/lib/http/same-origin';
import { reportError } from '@/lib/observability/report';

export const dynamic = 'force-dynamic';

/**
 * One whiteboard operation, persisted.
 *
 * A route handler rather than a Server Action, and that is the whole point: a
 * Server Action re-renders the route it was called from and sends the new tree
 * back to the browser. A teacher drawing a diagram sends an operation per
 * stroke — hundreds in a lesson — and every one of them was rebuilding the
 * whole classroom on the server. This answers with four bytes instead.
 *
 * No caller check here: `live_board_ops` admits staff only, so the database is
 * the gate, exactly as it was when this was an action. The failure answer
 * carries no detail for the same reason it carries no success payload — the
 * only reader who can act on it is a teacher mid-lesson, and their page has
 * already shown the stroke.
 */
const schema = z.object({
  sessionId: z.string().uuid(),
  op: z.unknown(),
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
  const { error } = await supabase
    .from('live_board_ops')
    .insert({ session_id: parsed.data.sessionId, op: parsed.data.op as never });

  if (error) {
    reportError('live.boardOp', error, { sessionId: parsed.data.sessionId });
    return NextResponse.json({ ok: false, error: 'saveFailed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
