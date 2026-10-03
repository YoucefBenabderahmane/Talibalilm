'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Gift, Lock, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActionForm } from '@/components/ui/action-form';
import { SubmitButton } from '@/components/auth/SubmitButton';
import { PayPalButton } from '@/components/checkout/PayPalButton';
import { claimFreeCourse, redeemOfficeCode, type PayState } from '@/app/actions/pay';
import type { PayPalPublicConfig } from '@/lib/paypal/types';

const EMPTY: PayState = {};

/** Action errors are keys, resolved here so a stray string cannot reach a reader. */
const MESSAGE: Record<
  string,
  | 'payUnavailable'
  | 'payRefused'
  | 'codeInvalid'
  | 'codeRefused'
  | 'codePartial'
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
  codeInvalid: 'codeInvalid',
  codeRefused: 'codeRefused',
  codePartial: 'codePartial',
  packExhausted: 'packExhausted',
  mixedCurrency: 'mixedCurrency',
  rateLimited: 'rateLimited',
  notFree: 'notFree',
  profileRequired: 'profileRequired',
  notApproved: 'notApproved',
  emailProvider: 'emailProvider',
};

/**
 * The two ways to pay.
 *
 * Neither form carries an amount. PayPal is opened by the SDK with an order id
 * the server minted after repricing the basket; the office form posts only a
 * code, which the database spends atomically.
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
  const [codeState, codeAction] = useActionState(redeemOfficeCode, EMPTY);
  const [freeState, freeAction] = useActionState(claimFreeCourse, EMPTY);

  const codeError = codeState.error ? MESSAGE[codeState.error] : undefined;
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
    <div className="space-y-6">
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

      <div className="rounded-[var(--radius-card)] border border-line bg-surface/50 p-5">
        <h2 className="flex items-center gap-2 font-display text-[15px] font-semibold text-ink">
          <Store className="size-4 text-brand-500" aria-hidden="true" />
          {t('payOffice')}
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{t('payOfficeBody')}</p>

        <ActionForm action={codeAction} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-[200px] flex-1">
            <span className="mb-1.5 block text-[13px] font-medium text-ink">
              {t('officeCodeLabel')}
            </span>
            <input
              name="code"
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={codeError ? true : undefined}
              className="w-full rounded-[var(--radius-input)] border border-line bg-white px-3 py-2.5 text-sm tracking-wide text-ink uppercase outline-none focus:border-brand-400"
            />
          </label>
          <SubmitButton variant="outline" size="md" block={false}>
            {t('officeCodeApply')}
          </SubmitButton>
        </ActionForm>

        {codeError && (
          <p role="alert" className="mt-3 text-[12px] text-red-600">
            {t(codeError)}
          </p>
        )}
      </div>
    </div>
  );
}
