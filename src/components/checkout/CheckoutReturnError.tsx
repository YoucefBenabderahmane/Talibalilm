'use client';

import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertCircle } from 'lucide-react';
import { ReturnErrorDialog } from '@/components/checkout/ReturnErrorDialog';

/** Errors handed back by the PayPal return and cancel routes, in the URL. */
const RETURN_ERRORS: Record<string, string> = {
  cancelled: 'payCancelled',
  amount_mismatch: 'payMismatch',
  not_completed: 'payNotCompleted',
  not_found: 'payUnexpected',
  unexpected: 'payUnexpected',
  unavailable: 'payUnavailable',
  paypalRefused: 'payRefused',
};

/**
 * The failure a PayPal redirect brought back, read from `?error=`.
 *
 * A client component on purpose: the checkout card sits on a module page whose
 * public shell is cached, and reading `searchParams` on the server would make
 * the whole page dynamic for a message that only exists after a failed
 * payment. The card renders it behind a Suspense boundary.
 */
export function CheckoutReturnError() {
  const params = useSearchParams();
  const t = useTranslations('checkout');
  const key = RETURN_ERRORS[params.get('error') ?? ''] ?? undefined;
  if (!key) return null;

  return (
    <>
      <ReturnErrorDialog message={t(key)} />
      <p
        role="alert"
        className="mb-5 flex items-start gap-2 rounded-[var(--radius-card)] border border-line bg-surface/60 p-4 text-[13px] leading-relaxed text-ink"
      >
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        {t(key)}
      </p>
    </>
  );
}
