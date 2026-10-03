'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { clientKey, rateLimit } from '@/lib/rate-limit';
import { currentViewer, isStaff } from '@/lib/auth/guards';
import { isAllowedProviderEmail } from '@/lib/validation/email-providers';
import { getStudentProfile, isApproved, profileComplete } from '@/lib/data/profile';
import { loadBasket } from '@/lib/commerce/basket';
import { couponDiscount, MixedCurrencyError } from '@/lib/commerce/quote';
import { clearSelection, EMPTY_SELECTION, writeSelection } from '@/lib/commerce/selection';
import { listProducts } from '@/lib/data/commerce';
import {
  createPendingOrder,
  attachProviderOrder,
  settleFreeOrder,
  settleOrder,
  settleInstallmentWithCoupon,
  markOrderFailed,
  PackExhaustedError,
} from '@/lib/commerce/orders';
import {
  capturePayPalOrder,
  createPayPalOrder,
  getPayPalConfig,
  PayPalPayerAction,
  PayPalRefusal,
} from '@/lib/paypal/client';
import { reportError } from '@/lib/observability/report';

/**
 * Payment.
 *
 * Both routes below reprice the basket from the catalogue before they do
 * anything. Neither accepts an amount, a product price, or a discount from the
 * caller — the only thing the browser contributes is a coupon code, and that
 * is spent by a single atomic UPDATE in the database.
 */

export type PayState = { error?: string };

/**
 * Throttle a checkout entry point by caller. Office codes are single-use and
 * worth a year of access, so guessing one must not be free; keying on both the
 * request address and, once known, the signed-in user closes the obvious ways
 * to spread the attempts out.
 */
async function throttle(scope: string, limit: number, userId?: string): Promise<boolean> {
  const key = userId
    ? `${clientKey(await headers(), scope)}:${userId}`
    : clientKey(await headers(), scope);
  const { ok } = await rateLimit(key, { limit, windowMs: 15 * 60 * 1000 });
  return ok;
}

async function requireUser(): Promise<{ id: string; email: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // An entitlement has to belong to somebody, so paying requires an account.
  // The selection survives the round trip in its own cookie.
  if (!user) redirect({ href: '/login?next=%2Fcourses', locale: await getLocale() });
  return { id: user.id, email: user.email ?? null };
}

/**
 * May this account open a NEW order?
 *
 * The school takes new subscriptions only from the mailbox providers it can
 * reach reliably — the same list new sign-ups must use. Registration already
 * refuses the others, so this catches the accounts that predate the rule or
 * were opened by the office on any address.
 *
 * It gates new orders only. Installments and desk codes settle a sale the
 * school already accepted, so they are not sent through here, and staff are
 * exempt because their address is the school's own.
 */
async function maySubscribe(user: { id: string; email: string | null }): Promise<boolean> {
  if (isAllowedProviderEmail(user.email)) return true;
  const viewer = await currentViewer();
  return viewer?.id === user.id && isStaff(viewer);
}

/**
 * Claim a coupon, or say why not.
 *
 * `redeem_coupon` increments the count inside its own WHERE clause, so a code
 * with one redemption left goes to exactly one of two simultaneous checkouts.
 * It is claimed HERE, at order creation — discovering a code was spent after
 * the student's money has moved is far worse than discovering it at the basket.
 */
/** Hand a coupon back when the order that claimed it never opened. */
async function releaseCoupon(couponId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.rpc('release_coupon', { coupon_id: couponId });
}

async function claimCoupon(
  code: string | null,
  subtotalCents: number,
): Promise<{ id: string; discountCents: number; isOffice: boolean } | null> {
  if (!code) return null;

  const supabase = createAdminClient();
  const { data: couponId } = await supabase.rpc('redeem_coupon', { coupon_code: code });
  if (!couponId) return null;

  const { data: coupon } = await supabase
    .from('coupons')
    .select('id, code, percent_off, amount_off_cents, is_office')
    .eq('id', couponId)
    .single();

  if (!coupon) return null;
  return {
    id: coupon.id,
    isOffice: coupon.is_office,
    discountCents: couponDiscount(
      {
        id: coupon.id,
        code: coupon.code,
        percentOff: coupon.percent_off,
        amountOffCents: coupon.amount_off_cents,
      },
      subtotalCents,
    ),
  };
}

/**
 * Open the order, in two steps the browser SDK can drive.
 *
 * `begin` prices the basket server-side, saves nothing about the amount in the
 * page, and hands back only PayPal's order id. `complete` captures that order
 * when PayPal's popup reports approval. The amount never crosses into the
 * browser, and neither does the secret: the SDK is loaded with the public
 * client id alone.
 *
 * A popup that cannot open falls back to PayPal's own page — the return_url
 * below is the same route the redirect flow used, so both paths settle
 * through the same server-side capture.
 */
export type BeginPayState =
  | { ok: true; free: true; orderId: string }
  | { ok: true; free: false; orderId: string; paypalOrderId: string }
  | { ok: false; error: string };

export async function beginPayPalCheckout(): Promise<BeginPayState> {
  const user = await requireUser();

  // Opening a PayPal order claims a coupon and a pack seat; cap how fast one
  // caller can churn through those holds.
  if (!(await throttle('checkout-start', 20, user.id))) return { ok: false, error: 'rateLimited' };

  // The account has to be let in before it can order. Browsing and trial
  // lessons stay open; this is the school deciding who joins, not a paywall.
  if (!(await isApproved())) return { ok: false, error: 'notApproved' };

  // New orders only from the accepted mailbox providers. Checked before the
  // profile, because no amount of enrolment detail changes this answer.
  if (!(await maySubscribe(user))) return { ok: false, error: 'emailProvider' };

  // The enrolment details are required before money moves. The wizard only
  // reaches this step once they are saved, but a hand-posted action must not
  // be able to pay on a half-filled profile.
  if (!profileComplete(await getStudentProfile())) {
    return { ok: false, error: 'profileRequired' };
  }

  const { selection, quote } = await loadBasket();
  if (!quote || !selection.delivery) return { ok: false, error: 'emptyBasket' };

  // Checked after the basket is priced, not before: a basket that costs nothing
  // has no business being turned away because PayPal is unconfigured. The
  // zero-total branch below settles it without ever calling PayPal.
  const config = await getPayPalConfig();
  if (!config && quote.totalCents !== 0) return { ok: false, error: 'unavailable' };

  // The coupon is taken off the subtotal AFTER any offer, which is what the
  // claim and the pricing both assume. `quote.discountCents` may already hold
  // the previewed coupon, so it is taken back out here.
  const afterOffers = quote.subtotalCents - (quote.discountCents - quote.couponDiscountCents);
  const coupon = await claimCoupon(selection.couponCode, afterOffers);

  let order;
  try {
    order = await createPendingOrder({
      userId: user.id,
      delivery: selection.delivery,
      // A desk code is cash the office took, whatever page the student was on
      // when they typed it: the route says how it was paid, not where.
      route: coupon?.isOffice ? 'office' : 'paypal',
      quote,
      couponId: coupon?.id ?? null,
      couponDiscountCents: coupon?.discountCents ?? 0,
      // The plan the student chose. A coupon that zeroes the basket ignores
      // it — there is nothing to split.
      planSize: selection.installments,
    });
  } catch (cause) {
    // The order never opened, so nothing will ever release the coupon this
    // request claimed a moment ago. Hand it straight back.
    if (coupon) await releaseCoupon(coupon.id);
    if (cause instanceof PackExhaustedError) return { ok: false, error: 'packExhausted' };
    if (cause instanceof MixedCurrencyError) return { ok: false, error: 'mixedCurrency' };
    throw cause;
  }

  // A coupon that brought the total to zero never reaches PayPal: there is
  // nothing to capture, and the grant path is the same either way.
  if (order.totalCents === 0) {
    await settleFreeOrder(order.id);
    await clearSelection();
    return { ok: true, free: true, orderId: order.id };
  }

  if (!config) return { ok: false, error: 'unavailable' };

  try {
    const created = await createPayPalOrder({
      config,
      // On a plan this is the first installment, not the order total.
      amountCents: order.firstPaymentCents,
      currency: order.currency,
      referenceId: order.id,
      description: quote.lines.map((l) => l.title).join(', ') || 'Institut Talib Alim',
    });
    await attachProviderOrder(order.id, created.id);
    return { ok: true, free: false, orderId: order.id, paypalOrderId: created.id };
  } catch {
    // The order exists and is holding a coupon and a pack redemption. Nothing
    // downstream will ever release them, because the student is never going to
    // reach PayPal's cancel route — they are about to see an error instead.
    await markOrderFailed(order.id, 'PayPal would not open the order');
    // Deliberately vague to the student, because the detail here is about our
    // credentials rather than anything they can act on.
    return { ok: false, error: 'paypalRefused' };
  }
}

/**
 * Take the money once the popup reports approval.
 *
 * The browser sends only PayPal's order id. It is matched against our own
 * pending row — which must belong to the caller — before anything is captured,
 * and the captured amount is checked against that row by `settleOrder`. An id
 * alone is not authority to take money or hand out access.
 */
export async function completePayPalCheckout(
  paypalOrderId: string,
): Promise<{ ok: true; orderId: string } | { ok: false; error: string; url?: string }> {
  const user = await requireUser();

  // Every call is a round trip to PayPal; an authenticated client must not be
  // able to turn the capture endpoint into a free amplifier.
  if (!(await throttle('checkout-complete', 30, user.id))) {
    return { ok: false, error: 'rateLimited' };
  }

  const parsed = z.string().min(6).max(64).safeParse(paypalOrderId);
  if (!parsed.success) return { ok: false, error: 'payUnexpected' };

  const admin = createAdminClient();
  const { data: order } = await admin
    .from('orders')
    .select('id, user_id, status, plan_size')
    .eq('provider_order_id', parsed.data)
    .maybeSingle();

  // Not an order's own PayPal id: it may belong to one installment of a plan,
  // which the student pays from their space months after the first one.
  let targetOrderId = order?.id ?? null;
  if (order && order.user_id !== user.id) return { ok: false, error: 'payUnexpected' };

  if (!targetOrderId) {
    const { data: installment } = await admin
      .from('installments')
      .select('id, order_id, status, orders ( user_id )')
      .eq('provider_order_id', parsed.data)
      .maybeSingle();

    const owner = installment?.orders?.user_id ?? null;
    if (!installment || owner !== user.id) return { ok: false, error: 'payUnexpected' };
    if (installment.status === 'paid') return { ok: true, orderId: installment.order_id };
    targetOrderId = installment.order_id;
  }

  if (order && order.status === 'paid' && order.plan_size === 1) {
    await clearSelection();
    return { ok: true, orderId: order.id };
  }

  const config = await getPayPalConfig();
  if (!config) return { ok: false, error: 'unavailable' };

  try {
    const capture = await capturePayPalOrder(config, parsed.data);
    const settled = await settleOrder({
      orderId: targetOrderId,
      capturedCents: capture.amountCents,
      currency: capture.currency,
      captureId: capture.captureId,
      status: capture.status,
      // Identifies WHICH installment when the order carries a plan.
      paypalOrderId: parsed.data,
      paymentMethod: capture.paymentMethod,
    });

    if (!settled.ok) {
      const error =
        settled.reason === 'amount_mismatch'
          ? 'payMismatch'
          : settled.reason === 'not_completed'
            ? 'payNotCompleted'
            : 'payUnexpected';
      return { ok: false, error };
    }
  } catch (thrown) {
    // The buyer owes one more step at PayPal (a challenge or a review). The
    // order carries the link; the browser goes there and comes back through
    // the return route, which captures for real.
    if (thrown instanceof PayPalPayerAction) {
      return { ok: false, error: 'payerAction', url: thrown.url };
    }

    // PayPal named a reason. It goes on the order and into the log where the
    // office can read it; the student gets "the payment did not go through",
    // not "try again" — retrying cannot fix a refused capture.
    if (thrown instanceof PayPalRefusal) {
      reportError('paypal.capture', thrown, { orderId: targetOrderId, issue: thrown.issue });
      await markOrderFailed(targetOrderId, `capture refused: ${thrown.issue}`);
      return { ok: false, error: 'payNotCompleted' };
    }

    // A transient failure (network, 5xx). The order stays pending so a retry
    // or the sweep can deal with it, and the coupon is not released yet.
    return { ok: false, error: 'paypalRefused' };
  }

  await clearSelection();
  return { ok: true, orderId: targetOrderId };
}

/**
 * Pay the next installment of a plan, from the student's own space.
 *
 * The amount comes from the installment row, never from the browser: the
 * client sends an id, and the server decides what that id costs. The same
 * embedded PayPal flow then captures it — `completePayPalCheckout` finds the
 * installment by the PayPal order id and settles that one.
 */
export async function beginInstallmentPayment(installmentId: string): Promise<BeginPayState> {
  const user = await requireUser();

  if (!(await throttle('checkout-start', 20, user.id))) return { ok: false, error: 'rateLimited' };
  if (!(await isApproved())) return { ok: false, error: 'notApproved' };

  const parsed = z.string().uuid().safeParse(installmentId);
  if (!parsed.success) return { ok: false, error: 'payUnexpected' };

  const admin = createAdminClient();
  const { data: installment } = await admin
    .from('installments')
    .select('id, order_id, sequence, amount_cents, status')
    .eq('id', parsed.data)
    .maybeSingle();
  if (!installment || installment.status !== 'pending') {
    return { ok: false, error: 'payUnexpected' };
  }

  const { data: order } = await admin
    .from('orders')
    .select('id, user_id, status, currency')
    .eq('id', installment.order_id)
    .maybeSingle();
  // The plan has to be open — the first payment is what grants the course.
  if (!order || order.user_id !== user.id || order.status !== 'paid') {
    return { ok: false, error: 'payUnexpected' };
  }

  const config = await getPayPalConfig();
  if (!config) return { ok: false, error: 'unavailable' };

  try {
    const created = await createPayPalOrder({
      config,
      amountCents: installment.amount_cents,
      currency: order.currency,
      referenceId: order.id,
      description: `Institut Talib Alim — échéance ${installment.sequence}`,
    });

    await admin
      .from('installments')
      .update({ provider_order_id: created.id })
      .eq('id', installment.id);

    return { ok: true, free: false, orderId: order.id, paypalOrderId: created.id };
  } catch {
    return { ok: false, error: 'paypalRefused' };
  }
}

/**
 * Pay one installment with a code from the desk.
 *
 * The school's codes are 100 % ones, so a code covers an installment whole; a
 * partial code is refused rather than half-settling a payment. The coupon is
 * claimed atomically first and released if anything after it fails.
 */
export async function redeemInstallmentCode(
  _previous: PayState,
  formData: FormData,
): Promise<PayState> {
  const user = await requireUser();

  if (!(await throttle('office-code', 10, user.id))) return { error: 'rateLimited' };

  const parsed = z
    .object({ installmentId: z.string().uuid(), code: codeSchema })
    .safeParse({ installmentId: formData.get('installmentId'), code: formData.get('code') ?? '' });
  if (!parsed.success) return { error: 'codeInvalid' };

  const admin = createAdminClient();
  const { data: installment } = await admin
    .from('installments')
    .select('id, order_id, status')
    .eq('id', parsed.data.installmentId)
    .maybeSingle();
  if (!installment || installment.status !== 'pending') return { error: 'codeRefused' };

  const { data: order } = await admin
    .from('orders')
    .select('id, user_id')
    .eq('id', installment.order_id)
    .maybeSingle();
  if (!order || order.user_id !== user.id) return { error: 'codeRefused' };

  const { data: couponId } = await admin.rpc('redeem_coupon', {
    coupon_code: parsed.data.code,
  });
  if (!couponId) return { error: 'codeRefused' };

  const { data: coupon } = await admin
    .from('coupons')
    .select('percent_off')
    .eq('id', couponId)
    .maybeSingle();
  if (!coupon || coupon.percent_off !== 100) {
    await releaseCoupon(couponId);
    return { error: 'codePartial' };
  }

  const settled = await settleInstallmentWithCoupon(installment.id, couponId);
  if (!settled.ok) {
    await releaseCoupon(couponId);
    return { error: 'codeRefused' };
  }

  revalidatePath('/[locale]/dashboard', 'page');
  return {};
}

/**
 * The rows a free enrolment leaves, whichever door the student came through.
 *
 * A free course is not a discount and not a coupon — the catalogue simply
 * prices it at zero. It still produces a real order and real entitlements
 * through `settleFreeOrder`, the same rows a paid enrolment leaves, because
 * `has_course_access()` is what opens the lessons and it knows nothing about
 * how the sale was funded.
 *
 * The zero is never taken from the request. `loadBasket` reprices the selection
 * from the catalogue and `createPendingOrder` computes the total again; if that
 * total is not zero, the order is rolled back and the caller is sent to pay.
 *
 * Shared by the wizard's claim button and the module page's direct access, so
 * both leave identical rows and neither can drift from the other.
 */
async function claimFreeBasket(): Promise<
  { ok: true; orderId: string } | { ok: false; error: string }
> {
  const user = await requireUser();

  if (!(await throttle('checkout-start', 20, user.id))) return { ok: false, error: 'rateLimited' };
  if (!(await isApproved())) return { ok: false, error: 'notApproved' };
  if (!(await maySubscribe(user))) return { ok: false, error: 'emailProvider' };
  if (!profileComplete(await getStudentProfile())) {
    return { ok: false, error: 'profileRequired' };
  }

  const { selection, quote } = await loadBasket();
  if (!quote || !selection.delivery) return { ok: false, error: 'emptyBasket' };

  const afterOffers = quote.subtotalCents - (quote.discountCents - quote.couponDiscountCents);
  const coupon = await claimCoupon(selection.couponCode, afterOffers);

  let order;
  try {
    order = await createPendingOrder({
      userId: user.id,
      delivery: selection.delivery,
      route: coupon?.isOffice ? 'office' : 'free',
      quote,
      couponId: coupon?.id ?? null,
      couponDiscountCents: coupon?.discountCents ?? 0,
    });
  } catch (cause) {
    if (coupon) await releaseCoupon(coupon.id);
    if (cause instanceof PackExhaustedError) return { ok: false, error: 'packExhausted' };
    if (cause instanceof MixedCurrencyError) return { ok: false, error: 'mixedCurrency' };
    throw cause;
  }

  // The catalogue disagreed with the page: something in the basket costs money.
  if (order.totalCents !== 0) {
    await markOrderFailed(order.id, 'not a free basket');
    return { ok: false, error: 'notFree' };
  }

  await settleFreeOrder(order.id);
  await clearSelection();
  return { ok: true, orderId: order.id };
}

/**
 * Take a course the school is giving away, from the checkout wizard.
 *
 * It exists as its own route because `beginPayPalCheckout` refuses before it
 * ever reaches the zero-total branch when PayPal is not configured — so a
 * school that had not linked PayPal could not give anything away.
 */
export async function claimFreeCourse(_previous: PayState, _formData: FormData): Promise<PayState> {
  const locale = await getLocale();
  const result = await claimFreeBasket();
  if (!result.ok) {
    if (result.error === 'emptyBasket') redirect({ href: '/courses', locale });
    return { error: result.error };
  }

  // Straight to what they now hold — no receipt page, no "open my module".
  redirect({ href: await checkoutTarget(result.orderId), locale });
}

/**
 * Direct access to a free module, from the module's own page.
 *
 * The page has already told the student the module costs nothing; this is the
 * one button that acts on it. It resolves the published product for the chosen
 * mode and checks its price HERE — the page is not trusted to say what is free
 * — then writes the same selection the wizard would have written and settles
 * through the same `claimFreeBasket`. A module that turns out to cost money is
 * refused with `notFree` rather than quietly given away.
 */
export async function claimFreeModule(_previous: PayState, formData: FormData): Promise<PayState> {
  const locale = await getLocale();

  const parsed = z
    .object({
      courseId: z.string().uuid(),
      delivery: z.enum(['presentiel', 'online']),
    })
    .safeParse({ courseId: formData.get('courseId'), delivery: formData.get('delivery') });
  if (!parsed.success) return { error: 'payUnexpected' };

  const offered = await listProducts(parsed.data.delivery);
  const product = offered.find(
    (entry) => entry.kind === 'module' && entry.courseId === parsed.data.courseId,
  );
  if (!product || product.priceCents !== 0) return { error: 'notFree' };

  await writeSelection({
    ...EMPTY_SELECTION,
    kind: 'module',
    courseId: parsed.data.courseId,
    delivery: parsed.data.delivery,
    productIds: [product.id],
  });

  const result = await claimFreeBasket();
  if (!result.ok) return { error: result.error };

  // Straight to the module, not to a confirmation page: there is no payment to
  // announce, and the lessons are already open.
  redirect({ href: await checkoutTarget(result.orderId), locale });
}

const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{6,32}$/);

/**
 * Where a paid order should open.
 *
 * A module opens its own page, where every lesson is a link because the
 * student holds it. A cursus opens the cursus page on the mode that was
 * bought, where every module of the programme is listed and each opens its
 * own page. Read through the ordinary client, so `orders_select_own` decides
 * what a caller can see — an order id belonging to somebody else resolves to
 * the dashboard and nothing more.
 */
export async function checkoutTarget(orderId: string): Promise<string> {
  const user = await requireUser();
  const parsed = z.string().uuid().safeParse(orderId);
  if (!parsed.success) return '/dashboard';

  const supabase = await createClient();
  const { data: order } = await supabase
    .from('orders')
    .select('id, user_id, status, order_items ( kind, course_id, cursus_id, delivery )')
    .eq('id', parsed.data)
    .maybeSingle();
  if (!order || order.user_id !== user.id || order.status !== 'paid') return '/dashboard';

  const first = order.order_items?.[0];
  if (!first) return '/dashboard';

  if (first.kind === 'cursus' && first.cursus_id) {
    const { data: cursus } = await supabase
      .from('cursus')
      .select('slug')
      .eq('id', first.cursus_id)
      .maybeSingle();
    return cursus?.slug ? `/cursus/${cursus.slug}?mode=${first.delivery}` : '/dashboard';
  }

  if (first.kind !== 'module' || !first.course_id) return '/dashboard';

  const { data: course } = await supabase
    .from('courses')
    .select('slug')
    .eq('id', first.course_id)
    .maybeSingle();
  return course?.slug ? `/courses/${course.slug}` : '/dashboard';
}
