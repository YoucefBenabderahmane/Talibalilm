'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import {
  beginInstallmentPayment,
  beginPayPalCheckout,
  checkoutTarget,
  completePayPalCheckout,
} from '@/app/actions/pay';

/**
 * PayPal's own buttons, loaded in the page.
 *
 * The SDK needs the public client id and nothing else: `createOrder` asks our
 * server to open the order (which prices the basket from the catalogue and
 * returns PayPal's order id), and `onApprove` asks our server to capture it.
 * The amount and the secret never enter this file, and the browser only ever
 * sees an order id it is not trusted to invent.
 *
 * The order is created WITHOUT a payment_source, deliberately — that is what
 * the SDK popup flow requires. With one, PayPal treats the order as an
 * Expanded Checkout order whose approval belongs to its own redirect page, and
 * every capture comes back 422 (see `createPayPalOrder`).
 *
 * Both outcomes end in a dialog: a thank-you that takes the student to what
 * they bought, or the refusal in words they can act on. A student who is sent
 * to PayPal for one more step (a challenge) is redirected and comes back
 * through the return route.
 */

interface PayPalButtonsInstance {
  render: (target: HTMLElement) => Promise<void>;
  close?: () => void;
}

interface PayPalSdk {
  Buttons: (options: {
    style?: Record<string, string | number>;
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }) => Promise<void>;
    onCancel?: () => void;
    onError?: (error: unknown) => void;
  }) => PayPalButtonsInstance;
}

declare global {
  interface Window {
    paypal?: PayPalSdk;
  }
}

/** Action errors are keys; this resolves them to sentences in the reader's locale. */
const MESSAGE: Record<string, string> = {
  unavailable: 'payUnavailable',
  paypalRefused: 'payRefused',
  rateLimited: 'rateLimited',
  packExhausted: 'packExhausted',
  mixedCurrency: 'mixedCurrency',
  profileRequired: 'profileRequired',
  notApproved: 'notApproved',
  emailProvider: 'emailProvider',
  emptyBasket: 'emptyBasket',
  payMismatch: 'payMismatch',
  payNotCompleted: 'payNotCompleted',
  payUnexpected: 'payUnexpected',
};

const SCRIPT_ID = 'paypal-sdk';

export function PayPalButton({
  clientId,
  currency,
  locale,
  installmentId,
}: {
  clientId: string;
  currency: string;
  locale: string;
  /**
   * Pay one installment of a plan instead of the basket. The amount still
   * comes from the server — this only says WHICH row is being settled.
   */
  installmentId?: string;
}) {
  const t = useTranslations('checkout');
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const settled = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const showError = useCallback(
    (key: string, { dialog = true }: { dialog?: boolean } = {}) => {
      setError(t(MESSAGE[key] ?? 'payUnexpected'));
      setErrorOpen(dialog);
    },
    [t],
  );

  /**
   * Straight to what was bought, with no thank-you dialog in between: the
   * module's own page, or the cursus page on the mode that was paid for. An
   * installment payment has nothing to open — it goes to the student's space.
   */
  const goToAccess = useCallback(
    async (orderId: string) => {
      if (installmentId) {
        router.push('/dashboard');
        return;
      }
      router.push(await checkoutTarget(orderId));
    },
    [installmentId, router],
  );

  const renderButtons = useCallback(() => {
    const target = container.current;
    if (!target || !window.paypal) return;

    // React strict mode mounts effects twice in development; clearing first
    // keeps a second set of buttons from stacking under the first.
    target.innerHTML = '';

    try {
      window.paypal
        .Buttons({
          style: { layout: 'vertical', shape: 'pill', color: 'gold', label: 'paypal', height: 48 },
          createOrder: async () => {
            setError(null);
            setErrorOpen(false);
            settled.current = false;
            const result = installmentId
              ? await beginInstallmentPayment(installmentId)
              : await beginPayPalCheckout();
            if (!result.ok) {
              showError(result.error);
              throw new Error(result.error);
            }
            // A coupon can take the basket to zero between the page rendering
            // and the button being pressed. Nothing to capture: the order is
            // already settled, so the student goes straight to it.
            if (result.free) {
              settled.current = true;
              await goToAccess(result.orderId);
              throw new Error('free');
            }
            return result.paypalOrderId;
          },
          onApprove: async (data) => {
            const result = await completePayPalCheckout(data.orderID);
            if (!result.ok) {
              // One more step at PayPal (a challenge). The order carries the
              // link; it brings the buyer back through the return route.
              if (result.error === 'payerAction' && result.url) {
                window.location.assign(result.url);
                return;
              }
              showError(result.error);
              return;
            }
            settled.current = true;
            await goToAccess(result.orderId);
          },
          onCancel: () => {
            // A cancellation is not a failure; it is said under the button.
            if (!settled.current) showError('payCancelled', { dialog: false });
          },
          onError: () => {
            // The deliberate abort for the free branch is not an error to show.
            if (!settled.current) showError('payUnexpected');
          },
        })
        .render(target)
        .catch(() => setFailed(true));
    } catch {
      // A synchronous refusal from the SDK (bad client id, blocked script) is
      // not a page error; the payment block reports it like any other outage.
      setFailed(true);
    }
  }, [installmentId, showError, goToAccess]);

  useEffect(() => {
    let cancelled = false;
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;

    const onLoad = () => {
      if (cancelled) return;
      setLoading(false);
      renderButtons();
    };
    const onError = () => {
      if (cancelled) return;
      setLoading(false);
      setFailed(true);
    };

    if (window.paypal) {
      setLoading(false);
      renderButtons();
      return;
    }

    const script = existing ?? document.createElement('script');
    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(
        clientId,
      )}&currency=${encodeURIComponent(currency)}&intent=capture&components=buttons&locale=${
        locale === 'en' ? 'en_US' : 'fr_FR'
      }`;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);

    return () => {
      cancelled = true;
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
    };
  }, [clientId, currency, locale, renderButtons]);

  return (
    <div>
      {loading && (
        <p className="flex items-center gap-2 text-[13px] text-ink-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t('paypalOpening')}
        </p>
      )}

      <div ref={container} />

      {failed && (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">{t('payUnavailable')}</p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[12px] text-red-600">
          {error}
        </p>
      )}

      <Dialog open={errorOpen} title={t('payErrorTitle')} onClose={() => setErrorOpen(false)}>
        <p>{error}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="md" onClick={() => setErrorOpen(false)}>
            {t('payRetry')}
          </Button>
          <button
            type="button"
            onClick={() => setErrorOpen(false)}
            className="text-[13px] text-ink-muted transition-colors hover:text-ink"
          >
            {t('payClose')}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
