import { NextResponse, type NextRequest } from 'next/server';
import { fromPayPalAmount, getPayPalConfig, verifyWebhookSignature } from '@/lib/paypal/client';
import { revokeOrder, settleOrder } from '@/lib/commerce/orders';
import { createAdminClient } from '@/lib/supabase/server';
import { reportError } from '@/lib/observability/report';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PayPal's own account of what happened.
 *
 * The return route already captures and grants, so in the ordinary case this
 * arrives second and does nothing. It exists for the case that matters: the
 * student closes the tab on PayPal's page after approving, never comes back,
 * and their money has moved anyway. Without this they would have paid for
 * nothing.
 *
 * The signature check is not optional and there is no path around it. PayPal
 * has no shared secret to HMAC, so verifying costs a round trip to their API
 * on every delivery — an unverified body is just a stranger claiming a payment
 * completed.
 */
/**
 * Events that mean the money is gone and the access must go with it.
 *
 * The value is the reason written onto the order, in the words the office will
 * read when a student asks why their access stopped.
 */
const REVOKING_EVENTS = new Map<string, string>([
  ['PAYMENT.CAPTURE.REFUNDED', 'refunded through PayPal'],
  ['PAYMENT.CAPTURE.REVERSED', 'payment reversed by PayPal'],
  ['PAYMENT.CAPTURE.DENIED', 'capture denied'],
  ['CUSTOMER.DISPUTE.CREATED', 'payment disputed by the buyer'],
]);

export async function POST(request: NextRequest) {
  const raw = await request.text();

  const config = await getPayPalConfig();
  // 200 rather than an error: PayPal retries anything else for days, and a
  // site with no PayPal configured has nothing to retry into.
  if (!config) return NextResponse.json({ ignored: 'not_configured' });

  const verified = await verifyWebhookSignature({ config, headers: request.headers, rawBody: raw });
  if (!verified) {
    // A forged or misconfigured webhook is worth an alert: it is either an
    // attack or the webhook id is wrong and no notification will ever verify.
    reportError('paypal.webhook.signature', new Error('signature verification failed'));
    return NextResponse.json({ error: 'signature' }, { status: 401 });
  }

  const event = JSON.parse(raw) as {
    id?: string;
    event_type?: string;
    resource?: {
      id?: string;
      status?: string;
      custom_id?: string;
      invoice_id?: string;
      amount?: { value?: string; currency_code?: string };
      payment_source?: Record<string, unknown>;
      supplementary_data?: { related_ids?: { order_id?: string } };
    };
  };

  const kind = event.event_type ?? 'unknown';

  // `custom_id` is our own order id, put there when the order was opened. It
  // is the only field here we trust to identify the order, and even then the
  // amount is checked against the row before anything is granted.
  const orderId = event.resource?.custom_id;

  // Counted once. PayPal redelivers an event until it gets a 2xx and sends
  // more than one for a single refund, and `revoke_order_entitlements` used to
  // subtract the order's days on every call — so a refund could take back
  // years the student had bought in other orders. The event id is written
  // before anything is acted on; a second write of the same id is a replay.
  // A ledger failure is reported but does not drop a payment.
  if (event.id) {
    const { error } = await createAdminClient()
      .from('paypal_webhook_events')
      .insert({
        event_id: event.id,
        event_type: kind,
        order_id: orderId && UUID.test(orderId) ? orderId : null,
      });
    if (error?.code === '23505') return NextResponse.json({ duplicate: event.id });
    if (error) reportError('paypal.webhook.ledger', error, { eventId: event.id, kind });
  } else {
    reportError('paypal.webhook.noEventId', new Error('webhook event without an id'), { kind });
  }

  if (!orderId) return NextResponse.json({ ignored: 'no_reference' });

  // The money went back, or never arrived. Access has to follow it. Before
  // these were handled, a refunded student kept their year and a chargeback
  // went unnoticed — `refunded` existed in the enum and was unreachable.
  if (REVOKING_EVENTS.has(kind)) {
    await revokeOrder(orderId, REVOKING_EVENTS.get(kind) ?? kind);
    console.warn('[paypal] revoked access for order', orderId, 'after', kind);
    return NextResponse.json({ revoked: orderId, reason: kind });
  }

  if (kind !== 'PAYMENT.CAPTURE.COMPLETED') {
    return NextResponse.json({ ignored: kind });
  }

  const value = event.resource?.amount?.value;
  const settled = await settleOrder({
    orderId,
    capturedCents: value ? fromPayPalAmount(value) : null,
    currency: event.resource?.amount?.currency_code ?? null,
    captureId: event.resource?.id ?? null,
    status: event.resource?.status ?? 'UNKNOWN',
    // Which installment, when the order carries a plan. PayPal echoes the
    // order id here on every capture event.
    paypalOrderId: event.resource?.supplementary_data?.related_ids?.order_id ?? null,
    // The webhook body carries the capture's payment source too.
    paymentMethod:
      event.resource?.payment_source && 'card' in event.resource.payment_source
        ? 'card'
        : event.resource?.payment_source
          ? 'paypal'
          : null,
  });

  // Always 200 once the signature is good: a non-2xx makes PayPal retry, and
  // retrying will not turn a mismatched amount into a matching one.
  return NextResponse.json(settled);
}
