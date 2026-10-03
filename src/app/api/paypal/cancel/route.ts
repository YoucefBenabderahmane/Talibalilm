import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { cancelOrder } from '@/lib/commerce/orders';
import { paypalFailurePath } from '@/lib/commerce/paypal-failure';
import { siteUrl } from '@/lib/env';

/**
 * The student backed out at PayPal.
 *
 * The order is cancelled and any coupon it claimed is handed back, so changing
 * your mind does not quietly burn a single-use code. The selection cookie is
 * left alone — they are returned to the module they were buying, with their
 * basket intact and the cancellation said under the button.
 */
export async function GET(request: NextRequest) {
  const base = siteUrl();
  const orderId = request.nextUrl.searchParams.get('order');

  if (orderId) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) await cancelOrder(orderId, user.id);
  }

  return NextResponse.redirect(`${base}${await paypalFailurePath(orderId, 'cancelled')}`);
}
