import { NextResponse, type NextRequest } from 'next/server';
import { roomSlides, signSlide } from '@/lib/data/live';

export const dynamic = 'force-dynamic';

/**
 * Slide links, for a viewer already in the room.
 *
 * Two shapes, because the room has two needs:
 *
 *   ?session=…        the whole deck, signed. Used when the teacher adds
 *                     slides mid-lesson and when the slides panel opens.
 *   ?session=…&id=…   one slide, signed. Used when a page is presented: the
 *                     deck arrives without links, and only the page on stage
 *                     is minted. A passive join costs nothing.
 *
 * A GET and not a Server Action: the room calls this during a lesson, and an
 * action would rebuild the whole classroom on the server — signed URLs for
 * the entire deck included — just to hand back a list. Reading is still gated
 * per caller by `can_read_slide()` inside the data layer, so the room's
 * answer is the same either way.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session') ?? '';
  const slideId = request.nextUrl.searchParams.get('id');

  if (slideId) {
    return NextResponse.json({ url: await signSlide(sessionId, slideId) });
  }

  return NextResponse.json({ slides: await roomSlides(sessionId) });
}
