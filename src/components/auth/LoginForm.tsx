'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Field } from '@/components/ui/field';
import { ActionForm } from '@/components/ui/action-form';
import { FormMessage } from '@/components/auth/AuthCard';
import { SubmitButton } from '@/components/auth/SubmitButton';
import { Turnstile, type TurnstileHandle } from '@/components/auth/Turnstile';
import { login, type ActionState } from '@/app/actions/auth';

const EMPTY: ActionState = { ok: false };

/**
 * The login form.
 *
 * `?next=`, `?reset=1` and `?error=` are read here rather than on the page:
 * the page stays static, and these values only exist after a redirect or a
 * failed link. Read in an effect, not during render, so the server's HTML and
 * the first client render agree — the notice appears a moment after mount.
 */
export function LoginForm() {
  const t = useTranslations('auth');
  const tErrors = useTranslations('authErrors');
  const [state, action] = useActionState(login, EMPTY);
  const captcha = useRef<TurnstileHandle>(null);
  const [query, setQuery] = useState<URLSearchParams | null>(null);

  useEffect(() => {
    setQuery(new URLSearchParams(window.location.search));
  }, []);

  // Sanitised here as well as in the server action. The action is what makes
  // it safe; this keeps an attacker-supplied absolute URL from being reflected
  // into the page's markup in the first place.
  const rawNext = query?.get('next') ?? null;
  const next = rawNext?.startsWith('/') && !rawNext.startsWith('//') ? rawNext : undefined;
  const notice = query?.get('reset') === '1' ? t('resetDone') : undefined;
  const error = query?.get('error');
  const calloutError =
    error === 'expiredLink' ? tErrors('expiredLink') : error ? tErrors('unexpected') : undefined;

  // A wrong password spends the token like any other attempt; without this,
  // the correction that follows is refused as a failed anti-robot check.
  useEffect(() => {
    captcha.current?.reset();
  }, [state]);

  return (
    <ActionForm action={action} className="space-y-4" noValidate>
      {notice && <FormMessage tone="success">{notice}</FormMessage>}
      {calloutError && <FormMessage tone="error">{calloutError}</FormMessage>}
      {state.message && <FormMessage tone="error">{state.message}</FormMessage>}

      {next && <input type="hidden" name="next" value={next} />}

      <Field
        label={t('email')}
        name="email"
        type="email"
        autoComplete="email"
        required
        error={state.fieldErrors?.['email']}
      />
      <Field
        label={t('password')}
        name="password"
        type="password"
        autoComplete="current-password"
        required
        error={state.fieldErrors?.['password']}
      />

      <div className="flex justify-end">
        <Link href="/forgot-password" className="text-xs text-brand-600 underline-offset-4 hover:underline">
          {t('forgotLink')}
        </Link>
      </div>

      <Turnstile ref={captcha} />

      <SubmitButton>{t('submitLogin')}</SubmitButton>
    </ActionForm>
  );
}
