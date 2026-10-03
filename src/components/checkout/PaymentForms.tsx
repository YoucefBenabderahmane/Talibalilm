'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Gift, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActionForm } from '@/components/ui/action-form';
import { SubmitButton } from '@/components/auth/SubmitButton';
import { PayPalButton } from '@/components/checkout/PayPalButton';
import { claimFreeCourse, type PayState } from '@/app/actions/pay';
import type { PayPalPublicConfig } from '@/lib/paypal/types';

const EMPTY: PayState = {};

/** Action errors are keys, resolved here so a stray string cannot reach a reader. */
const MESSAGE: Record<
  string,
  | 'payUnavailable'
  | 'payRefused'
  | 'packExhausted'
  | 'mixedCurrency'
  | 'rateLimited'
  | 'notFree'
  | 'profileRequired'
  | 'notApproved'
  | 'emailProvider'
> = {
  unavailable: 'payUnavailable',
  paypalRefused: 'payRefused',
  packExhausted: 'packExhausted',
  mixedCurrency: 'mixedCurrency',
  rateLimited: 'rateLimited',
  notFree: 'notFree',
  profileRequired: 'profileRequired',
  notApproved: 'notApproved',
  emailProvider: 'emailProvider',
};

/**
 * The way to pay.
 *
 * PayPal is opened by the SDK with an order id the server minted after
 * repricing the basket. A promo or desk code is typed once, in the field above
 * this card — the coupon preview stores it, and the order claims it when the
 * PayPal button opens it (a 100 %-off desk code settles without PayPal).
 */
export function PaymentForms({
  paypal,
  free = false,
  locale,
}: {
  /** Public config only — the secret stays on the server. */
  paypal: PayPalPublicConfig | null;
  /** The basket totals zero once repriced from the catalogue. */
  free?: boolean;
  locale: string;
}) {
  const t = useTranslations('checkout');
  const [freeState, freeAction] = useActionState(claimFreeCourse, EMPTY);

  const freeError = freeState.error ? MESSAGE[freeState.error] : undefined;

  // Nothing to pay: showing a PayPal button and a cash-code box here would be
  // asking the student to settle a bill of zero. One button, and it is done.
  if (free) {
    return (
      <ActionForm action={freeAction}>
        <SubmitButton>
          <Gift className="size-4" aria-hidden="true" />
          {t('claimFree')}
        </SubmitButton>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">{t('claimFreeNote')}</p>
        {freeError && (
          <p role="alert" className="mt-3 text-[12px] text-red-600">
            {t(freeError)}
          </p>
        )}
      </ActionForm>
    );
  }

  return (
    <div>
      {paypal ? (
        <div>
          <PayPalButton clientId={paypal.clientId} currency={paypal.currency} locale={locale} />
          <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">{t('paypalNote')}</p>
        </div>
      ) : (
        <div>
          <Button block size="lg" disabled>
            <Lock className="size-4" aria-hidden="true" />
            {t('payWithPaypal')}
          </Button>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">{t('payUnavailable')}</p>
        </div>
      )}
    </div>
  );
}
