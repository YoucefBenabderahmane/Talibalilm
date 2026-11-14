import 'server-only';
import { headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { clientKey, rateLimit } from '@/lib/rate-limit';
import { couponDiscount, type AppliedCoupon } from '@/lib/commerce/quote';

/**
 * Reading a coupon without spending it.
 *
 * The payment step has to show what a code takes off before the student
 * commits — a discount discovered only after the money moved is not a
 * discount anyone trusts. The read goes through the service role because
 * `authenticated` holds no SELECT on `coupons` at all: a student who could
 * list them could try the front desk's batch.
 *
 * This is a PREVIEW. `redeem_coupon` is still the only thing that claims one,
 * atomically, at order creation; nothing here increments a counter.
 *
 * The refusal is specific rather than a single "no": the office generating a
 * batch and the student typing a code both need to know whether it is unknown,
 * past its date, or already used — those are three different phone calls.
 */

export type CouponRefusal = 'unknown' | 'expired' | 'exhausted';

export type CouponPreview =
  | { status: 'none' }
  | { status: 'valid'; coupon: AppliedCoupon; discountCents: number }
  | { status: 'invalid'; reason: CouponRefusal };

export async function previewCoupon(
  code: string | null,
  /** What the coupon is taken off: the subtotal after any offer. */
  afterOffersCents: number,
): Promise<CouponPreview> {
  if (!code) return { status: 'none' };
  if (!supabaseConfigured) return { status: 'invalid', reason: 'unknown' };

  // The payment step previews whatever code the checkout cookie holds, and
  // the cookie is edited as easily as the form — so this path has to carry
  // its own limit or the apply button's limit means nothing. Wider than that
  // one, because every reload of the step is a preview too; a refusal reads as
  // an unknown code, which gives a guesser nothing.
  const { ok } = await rateLimit(clientKey(await headers(), 'coupon-preview'), {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (!ok) return { status: 'invalid', reason: 'unknown' };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('coupons')
    .select('id, code, percent_off, amount_off_cents, max_redemptions, redeemed_count, expires_at')
    .eq('code', code)
    .maybeSingle();

  if (error || !data) return { status: 'invalid', reason: 'unknown' };

  // The same conditions `redeem_coupon` applies, checked here so the screen
  // does not promise a discount the database will then refuse.
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    return { status: 'invalid', reason: 'expired' };
  }
  if (data.max_redemptions !== null && data.redeemed_count >= data.max_redemptions) {
    return { status: 'invalid', reason: 'exhausted' };
  }

  const coupon: AppliedCoupon = {
    id: data.id,
    code: data.code,
    percentOff: data.percent_off,
    amountOffCents: data.amount_off_cents,
  };

  return { status: 'valid', coupon, discountCents: couponDiscount(coupon, afterOffersCents) };
}
