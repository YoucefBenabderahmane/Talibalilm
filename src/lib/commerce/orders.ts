import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import type { Quote } from '@/lib/commerce/quote';
import { sendOrderConfirmation } from '@/lib/commerce/notify';
import { planDueDates, splitInstallments } from '@/lib/commerce/plan';
import { reportError } from '@/lib/observability/report';
import type { DeliveryMode, PaymentRoute } from '@/lib/supabase/database.types';

/**
 * Turning a priced basket into an order, and an order into access.
 *
 * Both payment routes come through here — PayPal and the front desk's cash
 * coupon — so the two cannot drift. The service role is used because
 * `authenticated` holds no INSERT on `orders` at all: a browser that could
 * write an order could name its own total.
 *
 * Everything below assumes `quote` was produced by `priceSelection` in this
 * same request, from ids checked against the published catalogue. Nothing here
 * re-derives a price, and nothing here accepts one from a caller's caller.
 */

export interface CreateOrderInput {
  userId: string;
  delivery: DeliveryMode;
  route: PaymentRoute;
  quote: Quote;
  /** Already claimed through `redeem_coupon`, or null. */
  couponId?: string | null;
  couponDiscountCents?: number;
  /** 1 for a single payment, 3 for the plan the school offers. */
  planSize?: number;
}

export interface CreatedOrder {
  id: string;
  totalCents: number;
  currency: string;
  /** What is due at checkout: the first installment on a plan, else the total. */
  firstPaymentCents: number;
}



/** The offer ran out between the student seeing it and pressing pay. */
export class PackExhaustedError extends Error {
  constructor(readonly packId: string) {
    super(`Pack ${packId} has no redemptions left`);
    this.name = 'PackExhaustedError';
  }
}

export async function createPendingOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const { userId, delivery, route, quote, couponId = null, couponDiscountCents = 0 } = input;
  const supabase = createAdminClient();

  // `quote` may already carry a PREVIEWED coupon, because the payment step
  // shows the discounted total before the student commits. What is charged
  // here is the CLAIMED coupon's discount, so the preview is taken back out
  // first rather than counted twice.
  const offerDiscountCents = quote.discountCents - quote.couponDiscountCents;
  const discountCents = Math.min(offerDiscountCents + couponDiscountCents, quote.subtotalCents);
  const totalCents = quote.subtotalCents - discountCents;

  // A limited offer is only limited if something takes a redemption. The
  // counter and its CHECK have existed since the table was created and nothing
  // ever incremented them, so "first 20 students" was unlimited.
  const packId = quote.pack?.id ?? null;
  if (packId) {
    const { data: claimed } = await supabase.rpc('claim_pack', { pack_id: packId });
    if (claimed !== true) throw new PackExhaustedError(packId);
  }

  // A plan needs something to split. A basket the school is giving away has
  // no schedule, whatever the student clicked.
  const planSize = totalCents > 0 ? Math.min(Math.max(1, Math.trunc(input.planSize ?? 1)), 3) : 1;
  const amounts = splitInstallments(totalCents, planSize);

  const { data: order, error } = await supabase
    .from('orders')
    .insert({
      user_id: userId,
      route,
      delivery,
      subtotal_cents: quote.subtotalCents,
      discount_cents: discountCents,
      total_cents: totalCents,
      // From the products, not a constant. See `currencyOf`.
      currency: quote.currency,
      coupon_id: couponId,
      pack_id: packId,
      status: 'pending',
      plan_size: planSize,
    })
    .select('id, total_cents, currency')
    .single();

  if (error || !order) throw new Error(`Could not open the order: ${error?.message ?? 'no row'}`);

  const { error: itemsError } = await supabase.from('order_items').insert(
    quote.lines.map((line) => ({
      order_id: order.id,
      product_id: line.productId,
      kind: line.kind,
      course_id: line.courseId,
      cursus_id: line.cursusId,
      year_index: line.yearIndex,
      delivery: line.delivery,
      unit_price_cents: line.unitPriceCents,
      duration_days: line.durationDays,
      is_free: line.isFree,
      title: line.title,
    })),
  );

  // The deferred constraint on `order_items` compares their sum against the
  // subtotal, so a pricing mistake fails here rather than becoming an invoice.
  if (itemsError) {
    await supabase.from('orders').delete().eq('id', order.id);
    throw new Error(`Could not record what was ordered: ${itemsError.message}`);
  }

  if (planSize > 1) {
    const dates = planDueDates(new Date(), planSize);
    const { error: planError } = await supabase.from('installments').insert(
      amounts.map((amount, index) => ({
        order_id: order.id,
        sequence: index + 1,
        amount_cents: amount,
        // The first is due now — it is the payment at checkout. The rest are
        // three months apart, dated from the day the plan opened.
        due_at: dates[index]!.toISOString(),
      })),
    );

    if (planError) {
      // No half-built plan: the order goes with it.
      await supabase.from('orders').delete().eq('id', order.id);
      throw new Error(`Could not record the payment plan: ${planError.message}`);
    }
  }

  return {
    id: order.id,
    totalCents: order.total_cents,
    currency: order.currency,
    firstPaymentCents: amounts[0] ?? order.total_cents,
  };
}

export async function attachProviderOrder(orderId: string, providerOrderId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('orders')
    .update({ provider_order_id: providerOrderId })
    .eq('id', orderId);
  if (error) throw new Error(`Could not record the PayPal order id: ${error.message}`);
}

export type SettleResult =
  | { ok: true; alreadyPaid: boolean; orderId: string }
  | { ok: false; reason: 'not_found' | 'amount_mismatch' | 'not_completed' | 'not_pending' };

/**
 * Mark an order paid and hand over what it bought.
 *
 * Idempotent from end to end: the status check short-circuits a replay, and
 * `grant_order_entitlements` refuses to grant twice for the same order anyway.
 * PayPal retries its webhooks, and the return page and the webhook race each
 * other by design — whichever arrives second must be a no-op.
 *
 * The amount comparison is the important line. A capture that does not match
 * what we asked for is never accepted, however cleanly it was signed.
 *
 * An order with a plan goes through `settleInstallment`: what PayPal charges is
 * one installment, not the total, and the order is opened by the first one.
 */
export async function settleOrder(options: {
  orderId: string;
  capturedCents: number | null;
  currency: string | null;
  captureId: string | null;
  status: string;
  /** PayPal's order id, when the caller has it: it names WHICH installment. */
  paypalOrderId?: string | null;
  /** paypal or card, from the capture. Written to the order when it settles. */
  paymentMethod?: 'paypal' | 'card' | null;
}): Promise<SettleResult> {
  const { orderId, capturedCents, currency, captureId, status, paypalOrderId, paymentMethod } =
    options;
  const supabase = createAdminClient();

  const { data: order } = await supabase
    .from('orders')
    .select('id, status, total_cents, paid_cents, plan_size, currency, paid_at')
    .eq('id', orderId)
    .maybeSingle();

  if (!order) return { ok: false, reason: 'not_found' };

  if (order.plan_size > 1) {
    return settleInstallment(order, {
      capturedCents,
      currency,
      captureId,
      status,
      paypalOrderId,
      paymentMethod,
    });
  }

  if (order.status === 'paid') return { ok: true, alreadyPaid: true, orderId };

  if (status !== 'COMPLETED') {
    await markOrderFailed(orderId, `capture ${status}`);
    return { ok: false, reason: 'not_completed' };
  }

  if (capturedCents !== order.total_cents || (currency !== null && currency !== order.currency)) {
    // The gravest case: a payment cleared for an amount that does not match the
    // order. Never grant, and page someone — this should not be possible.
    reportError('paypal.settle.mismatch', new Error('captured amount mismatch'), {
      orderId,
      capturedCents,
      expected: order.total_cents,
      currency,
      expectedCurrency: order.currency,
    });
    await markOrderFailed(
      orderId,
      `captured ${capturedCents ?? '?'} ${currency ?? '?'}, expected ${order.total_cents} ${order.currency}`,
    );
    return { ok: false, reason: 'amount_mismatch' };
  }

  const { data: claimed, error } = await supabase
    .from('orders')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      provider_capture_id: captureId,
      paid_cents: order.total_cents,
      payment_method: paymentMethod ?? null,
    })
    .eq('id', orderId)
    // Only a pending order becomes paid.
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`Could not mark the order paid: ${error.message}`);

  if (!claimed) {
    // Nothing was pending to claim. The ordinary reason is the race this
    // function is built for: the webhook and the return page settle the same
    // capture, and the other one won a moment ago — then the order is paid,
    // the grant has happened, and this caller reports the same success. The
    // other reason is the one that used to go unnoticed: a capture that
    // landed on an order the sweep had cancelled or an earlier try had
    // failed. The money has moved and nobody has been granted anything, so
    // that is paged rather than papered over with a receipt.
    const { data: now } = await supabase
      .from('orders')
      .select('status')
      .eq('id', orderId)
      .maybeSingle();
    if (now?.status === 'paid') return { ok: true, alreadyPaid: true, orderId };

    reportError('paypal.settle.notPending', new Error('capture landed on a non-pending order'), {
      orderId,
      captureId,
      status: now?.status ?? order.status,
    });
    return { ok: false, reason: 'not_pending' };
  }

  await supabase.rpc('grant_order_entitlements', { oid: orderId });
  // The receipt is best-effort and idempotent; a failure here has already been
  // preceded by the access being granted, so it never blocks the sale.
  await sendOrderConfirmation(orderId);
  return { ok: true, alreadyPaid: false, orderId };
}

interface PlanOrder {
  id: string;
  status: string;
  total_cents: number;
  paid_cents: number;
  plan_size: number;
  currency: string;
  paid_at: string | null;
}

/**
 * One installment of a plan.
 *
 * The installment is the thing being paid, so the amount check is against ITS
 * amount and not the order's total. The claim is a conditional update on
 * `status = 'pending'`, so two callers racing — the popup and the webhook —
 * settle exactly one.
 */
async function settleInstallment(
  order: PlanOrder,
  capture: {
    capturedCents: number | null;
    currency: string | null;
    captureId: string | null;
    status: string;
    paypalOrderId?: string | null;
    paymentMethod?: 'paypal' | 'card' | null;
  },
): Promise<SettleResult> {
  const supabase = createAdminClient();

  const { data: installment } = capture.paypalOrderId
    ? await supabase
        .from('installments')
        .select('id, sequence, amount_cents, status')
        .eq('order_id', order.id)
        .eq('provider_order_id', capture.paypalOrderId)
        .maybeSingle()
    : await supabase
        .from('installments')
        .select('id, sequence, amount_cents, status')
        .eq('order_id', order.id)
        .eq('status', 'pending')
        .order('sequence', { ascending: true })
        .limit(1)
        .maybeSingle();

  // Nothing left to pay: a replay, or a plan already closed by a code.
  if (!installment) return { ok: true, alreadyPaid: true, orderId: order.id };
  if (installment.status === 'paid') return { ok: true, alreadyPaid: true, orderId: order.id };

  if (capture.status !== 'COMPLETED') return { ok: false, reason: 'not_completed' };

  if (
    capture.capturedCents !== installment.amount_cents ||
    (capture.currency !== null && capture.currency !== order.currency)
  ) {
    reportError('paypal.settle.mismatch', new Error('captured amount mismatch'), {
      orderId: order.id,
      installmentId: installment.id,
      capturedCents: capture.capturedCents,
      expected: installment.amount_cents,
      currency: capture.currency,
      expectedCurrency: order.currency,
    });
    // The plan is NOT failed over one bad capture: the installment stays due,
    // and the office sees the alert.
    return { ok: false, reason: 'amount_mismatch' };
  }

  return completeInstallment(order, installment.id, {
    providerCaptureId: capture.captureId,
    paymentMethod: capture.paymentMethod ?? null,
  });
}

/**
 * Mark one installment paid and move the order on.
 *
 * Shared by the PayPal path and the desk code: the only difference between
 * them is where the money came from, and everything after that — the claim,
 * the running total, the first-payment grant, the receipt — has to be the
 * same or the two routes drift.
 */
async function completeInstallment(
  order: PlanOrder,
  installmentId: string,
  payment: {
    providerCaptureId?: string | null;
    couponId?: string | null;
    paymentMethod?: 'paypal' | 'card' | null;
  },
): Promise<SettleResult> {
  const supabase = createAdminClient();

  // The claim. A second caller matches no row and stops here.
  const { data: claimed } = await supabase
    .from('installments')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      provider_capture_id: payment.providerCaptureId ?? null,
      coupon_id: payment.couponId ?? null,
    })
    .eq('id', installmentId)
    .eq('status', 'pending')
    .select('amount_cents')
    .maybeSingle();

  if (!claimed) return { ok: true, alreadyPaid: true, orderId: order.id };

  const firstPayment = order.paid_cents === 0;
  const paidCents = Math.min(order.paid_cents + claimed.amount_cents, order.total_cents);

  const { error } = await supabase
    .from('orders')
    .update({
      paid_cents: paidCents,
      // The first payment opens the course; the order stays paid from then on
      // even though a balance is still due — `paid_cents` carries that.
      status: 'paid',
      paid_at: order.paid_at ?? new Date().toISOString(),
      // Only on the first payment: the later ones are the same method anyway,
      // and overwriting would lose what the first one said.
      ...(order.paid_cents === 0 ? { payment_method: payment.paymentMethod ?? null } : {}),
    })
    .eq('id', order.id);

  if (error) throw new Error(`Could not record the installment: ${error.message}`);

  if (firstPayment) {
    await supabase.rpc('grant_order_entitlements', { oid: order.id });
    await sendOrderConfirmation(order.id);
  }

  return { ok: true, alreadyPaid: false, orderId: order.id };
}

/**
 * Settle one installment with a desk code.
 *
 * The school's codes are 100 % ones — the office collected the cash — so a
 * code covers an installment whole. Anything else is refused rather than
 * half-settling a payment.
 */
export async function settleInstallmentWithCoupon(
  installmentId: string,
  couponId: string,
): Promise<SettleResult> {
  const supabase = createAdminClient();

  const { data: installment } = await supabase
    .from('installments')
    .select('id, order_id, status')
    .eq('id', installmentId)
    .maybeSingle();
  if (!installment || installment.status !== 'pending') return { ok: false, reason: 'not_found' };

  const { data: order } = await supabase
    .from('orders')
    .select('id, status, total_cents, paid_cents, plan_size, currency, paid_at')
    .eq('id', installment.order_id)
    .maybeSingle();
  if (!order) return { ok: false, reason: 'not_found' };

  return completeInstallment(order as PlanOrder, installment.id, { couponId });
}

/** The next installment due on an order, for the payment screens. */
export async function nextInstallment(orderId: string): Promise<{
  id: string;
  sequence: number;
  amountCents: number;
  dueAt: string;
} | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('installments')
    .select('id, sequence, amount_cents, due_at')
    .eq('order_id', orderId)
    .eq('status', 'pending')
    .order('sequence', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return {
    id: data.id,
    sequence: data.sequence,
    amountCents: data.amount_cents,
    dueAt: data.due_at,
  };
}

/** A free order — the office cash route — is paid the moment it is created. */
export async function settleFreeOrder(orderId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('orders')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('status', 'pending');

  if (error) throw new Error(`Could not mark the order paid: ${error.message}`);
  await supabase.rpc('grant_order_entitlements', { oid: orderId });
  await sendOrderConfirmation(orderId);
}

/**
 * Give back the coupon and the pack redemption this order is holding.
 *
 * Idempotent in the database, by a stamp on the order rather than by hoping
 * this runs once — the cancel route, the failure path and the sweep all reach
 * it, and they race by design.
 */
export async function releaseHolds(orderId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.rpc('release_order_holds', { oid: orderId });
}

/**
 * Mark an order failed and give back everything it was holding.
 *
 * Exported because the capture paths need it too: when PayPal definitively
 * refuses a payment, the order must not stay pending until the sweep, and the
 * coupon and pack seat it claimed must go back into circulation now.
 */
export async function markOrderFailed(orderId: string, reason: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from('orders').update({ status: 'failed', status_reason: reason }).eq('id', orderId);
  await releaseHolds(orderId);
}

export async function cancelOrder(orderId: string, userId: string): Promise<void> {
  const supabase = createAdminClient();
  const { data: order } = await supabase
    .from('orders')
    .select('id, user_id, status')
    .eq('id', orderId)
    .maybeSingle();

  // Scoped to the owner: a cancel is triggered by a redirect back from PayPal,
  // and the order id travels in the URL.
  if (!order || order.user_id !== userId || order.status !== 'pending') return;

  await releaseHolds(orderId);
  await supabase
    .from('orders')
    .update({ status: 'cancelled', status_reason: 'cancelled at PayPal' })
    .eq('id', orderId);
}

/**
 * Take back what a refunded, denied or reversed payment paid for.
 *
 * The entitlement is wound back by exactly the days this order bought rather
 * than deleted, which is the only right answer once renewals stack: a student
 * who paid twice and was refunded once keeps the other year.
 */
export async function revokeOrder(orderId: string, reason: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc('revoke_order_entitlements', {
    oid: orderId,
    reason: reason.slice(0, 200),
  });
  if (error) throw new Error(`Could not revoke order ${orderId}: ${error.message}`);
}
