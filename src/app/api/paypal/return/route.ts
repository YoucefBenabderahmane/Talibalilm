import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  capturePayPalOrder,
  getPayPalConfig,
  PayPalPayerAction,
  PayPalRefusal,
} from '@/lib/paypal/client';
import { markOrderFailed, settleOrder } from '@/lib/commerce/orders';
import { paypalFailurePath } from '@/lib/commerce/paypal-failure';
import { checkoutTarget } from '@/app/actions/pay';
import { createAdminClient } from '@/lib/supabase/server';
import { reportError } from '@/lib/observability/report';
import { siteUrl } from '@/lib/env';

/**
 * Where PayPal sends the student back after they approve.
 *
 * The capture happens HERE, server-side, not in the browser. The `token` in
 * the query string is PayPal's order id, and it is matched against our own
 * pending order before anything is captured — an id alone is not authority to
 * take money or hand out access.
 *
 * This races the webhook on purpose. Whichever arrives second finds the order
 * already paid and does nothing.
 */
export async function GET(request: NextRequest) {
  const base = siteUrl();
  const orderId = request.nextUrl.searchParams.get('order');
  const paypalOrderId = request.nextUrl.searchParams.get('token');

  // Back to the module the student was buying, with the reason in the URL.
  // The checkout no longer has a page of its own to return to.
  const fail = async (reason: string) =>
    NextResponse.redirect(`${base}${await paypalFailurePath(orderId, reason)}`);

  if (!orderId || !paypalOrderId) return fail('unexpected');

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${base}/login?next=%2Fcourses`);

  // Read through the service role, but only after checking the row belongs to
  // the person who came back.
  const admin = createAdminClient();
  const { data: order } = await admin
    .from('orders')
    .select('id, user_id, status, provider_order_id')
    .eq('id', orderId)
    .maybeSingle();

  if (!order || order.user_id !== user.id) return fail('unexpected');
  if (order.provider_order_id !== paypalOrderId) return fail('unexpected');

  if (order.status === 'paid') {
    return NextResponse.redirect(`${base}${await checkoutTarget(order.id)}`);
  }

  const config = await getPayPalConfig();
  if (!config) return fail('unavailable');

  try {
    const capture = await capturePayPalOrder(config, paypalOrderId);
    const settled = await settleOrder({
      orderId: order.id,
      capturedCents: capture.amountCents,
      currency: capture.currency,
      captureId: capture.captureId,
      status: capture.status,
    });

    if (!settled.ok) return fail(settled.reason);
  } catch (thrown) {
    // The buyer owes one more step at PayPal; it brings them back here after.
    if (thrown instanceof PayPalPayerAction) return NextResponse.redirect(thrown.url);

    if (thrown instanceof PayPalRefusal) {
      reportError('paypal.capture', thrown, { orderId: order.id, issue: thrown.issue });
      await markOrderFailed(order.id, `capture refused: ${thrown.issue}`);
      // "The payment did not go through" — a refusal is not something a retry
      // fixes, so the student is not told to try again.
      return fail('not_completed');
    }

    return fail('paypalRefused');
  }

  // Straight to what was bought — the module page, or the cursus page on the
  // mode that was paid for. No thank-you dialog, no receipt to click past.
  return NextResponse.redirect(`${base}${await checkoutTarget(order.id)}`);
}
