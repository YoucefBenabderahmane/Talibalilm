'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { ActionForm } from '@/components/ui/action-form';
import { SubmitButton } from '@/components/auth/SubmitButton';
import { claimFreeModule, type PayState } from '@/app/actions/pay';

const EMPTY: PayState = {};

/** Action errors are keys, resolved here so a stray string cannot reach a reader. */
const MESSAGE: Record<string, string> = {
  rateLimited: 'rateLimited',
  notApproved: 'notApproved',
  profileRequired: 'profileRequired',
  emailProvider: 'emailProvider',
  notFree: 'notFree',
  emptyBasket: 'emptyBasket',
  payUnexpected: 'payUnexpected',
};

/**
 * The button that opens a free module.
 *
 * One per published mode, because the mode is the only thing the enrolment
 * still has to know — a student attends on site or by video, and the
 * entitlement is granted per mode. Everything else the page has already said:
 * the module costs nothing, and the student's details are complete.
 */
export function FreeModuleClaim({
  courseId,
  delivery,
  label,
}: {
  courseId: string;
  delivery: 'presentiel' | 'online';
  label: string;
}) {
  const t = useTranslations('checkout');
  const [state, action] = useActionState(claimFreeModule, EMPTY);
  const error = state.error ? MESSAGE[state.error] : undefined;

  return (
    <ActionForm action={action} className="flex flex-col items-center gap-2">
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="delivery" value={delivery} />
      <SubmitButton>{label}</SubmitButton>
      {error && (
        <p role="alert" className="text-[12px] text-red-600">
          {t(error)}
        </p>
      )}
    </ActionForm>
  );
}
