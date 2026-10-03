import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * Where a failed PayPal return puts the student back.
 *
 * The checkout lives on the module's own page now, so a failure sends them to
 * the module they were buying — with the error in the query string, where the
 * card's `CheckoutReturnError` reads it. A cursus order names no single module,
 * so it falls back to the catalogue.
 *
 * Read through the service role, but only ids the caller already proved are
 * theirs by reaching this route with the matching PayPal token. The answer is
 * a public page, so nothing here can leak: it is only where to land.
 */
export async function paypalFailurePath(
  orderId: string | null,
  reason: string,
): Promise<string> {
  let slug: string | null = null;

  if (orderId) {
    const admin = createAdminClient();
    const { data: item } = await admin
      .from('order_items')
      .select('course_id')
      .eq('order_id', orderId)
      .not('course_id', 'is', null)
      .limit(1)
      .maybeSingle();

    if (item?.course_id) {
      const { data: course } = await admin
        .from('courses')
        .select('slug')
        .eq('id', item.course_id)
        .maybeSingle();
      slug = course?.slug ?? null;
    }
  }

  const target = slug ? `/courses/${slug}` : '/courses';
  return `${target}?error=${encodeURIComponent(reason)}#inscription`;
}
