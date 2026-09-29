import { NextResponse, type NextRequest } from 'next/server';
import { roomSlides } from '@/lib/data/live';

export const dynamic = 'force-dynamic';

/**
 * The deck as it stands, for a viewer already in the room.
 *
 * A GET and not a Server Action: the room calls this when the teacher adds
 * slides mid-lesson, and an action would rebuild the whole classroom on the
 * server — signed URLs for the entire deck included — just to hand back a
 * list. Reading is still gated per caller by `can_read_slide()` inside
 * `roomSlides`, so the room's answer is the same either way.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session') ?? '';
  return NextResponse.json({ slides: await roomSlides(sessionId) });
}
