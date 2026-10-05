'use server';

import { headers } from 'next/headers';
import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { envProblem, supabaseConfigured, siteUrl } from '@/lib/env';
import { classifyAuthError } from '@/lib/auth/errors';
import { clientKey, rateLimit } from '@/lib/rate-limit';
import { reportError } from '@/lib/observability/report';
import { notifyOfficeOfRegistration } from '@/lib/auth/registrations';
import { notifyStaffOfRegistration } from '@/lib/push/server';
import {
  forgotPasswordSchema,
  loginSchema,
  magicLinkSchema,
  registerSchema,
  resetPasswordSchema,
} from '@/lib/validation/auth';

/**
 * Auth server actions.
 *
 * Every one of these re-validates its input with the same Zod schema the form
 * used. The client-side pass is a courtesy; this is the one that counts.
 */
export interface ActionState {
  ok: boolean;
  /** A resolved sentence, already localised — not a key. */
  message?: string;
  /** Field-level errors keyed by field name, already localised. */
  fieldErrors?: Record<string, string>;
}

/** Resolve the schemas' message keys through next-intl. */
async function resolveFieldErrors(
  issues: { path: PropertyKey[]; message: string }[],
): Promise<Record<string, string>> {
  const t = await getTranslations();
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const field = String(issue.path[0] ?? 'form');
    if (out[field]) continue;
    // Schema messages are keys like `validation.emailInvalid`. Anything that
    // is not a dotted key falls through as-is rather than rendering blank.
    out[field] = issue.message.includes('.') ? t(issue.message) : issue.message;
  }
  return out;
}

async function notConfigured(): Promise<ActionState> {
  // The visitor gets the same non-specific sentence as any other outage —
  // naming the missing variable would tell a stranger how far along the setup
  // is. The operator gets the detail in the server log, which is the only
  // place anyone can act on it.
  console.error('[auth] Supabase is not configured —', envProblem());
  const t = await getTranslations('authErrors');
  return { ok: false, message: t('unexpected') };
}

/**
 * Map Supabase's error strings onto our localised messages.
 *
 * Anything that falls through to the catch-all is logged with the raw text.
 * Before that, an unmapped error and a missing environment variable produced
 * exactly the same sentence with nothing written down anywhere — which is
 * indistinguishable from the site simply being broken.
 */
async function authErrorMessage(raw: string): Promise<string> {
  const key = classifyAuthError(raw);

  // Everything that stops someone getting an account is reported, not just
  // logged: these are the failures nobody discovers until a student says the
  // site is broken, and by then the Vercel log has rolled over.
  if (key === 'unexpected') {
    reportError('auth.unmapped', new Error(raw), { note: 'no pattern matched; add one' });
  }
  if (key === 'databaseError') {
    reportError('auth.databaseError', new Error(raw), {
      note: 'usually handle_new_user failing — migrations missing or partial',
    });
  }
  // A service did not answer. Reported because it names an outage somebody has
  // to go and look at — and because it is the branch that used to masquerade as
  // the generic catch-all, which is how it went unexamined.
  if (key === 'serviceUnavailable') {
    reportError('auth.serviceUnavailable', new Error(raw), {
      note: 'network or gateway failure reaching Supabase Auth — check Admin → Diagnostic → Latence',
    });
  }
  if (key === 'emailSendFailed') {
    reportError('auth.emailSendFailed', new Error(raw), {
      note: "Supabase's built-in sender is over its limit; configure custom SMTP",
    });
  }
  const t = await getTranslations('authErrors');
  return t(key);
}

async function guard(scope: string, limit: number): Promise<ActionState | null> {
  const key = clientKey(await headers(), scope);
  const { ok } = await rateLimit(key, { limit, windowMs: 15 * 60 * 1000 });
  if (ok) return null;
  const t = await getTranslations('authErrors');
  return { ok: false, message: t('rateLimited') };
}

/**
 * The Turnstile token, when the browser sent one.
 *
 * An unrendered widget still posts its hidden input, as an empty string —
 * and Supabase treats an empty string as a token it must verify, which fails.
 * Absent is the honest shape for "no widget on this deployment": with CAPTCHA
 * off in Supabase the option is ignored, and with it on the refusal names
 * itself.
 */
function captchaTokenFrom(formData: FormData): string | undefined {
  const value = formData.get('captchaToken');
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function login(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const limited = await guard('login', 10);
  if (limited) return limited;

  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, fieldErrors: await resolveFieldErrors(parsed.error.issues) };
  }
  if (!supabaseConfigured) return notConfigured();

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { captchaToken: captchaTokenFrom(formData) },
  });
  if (error) return { ok: false, message: await authErrorMessage(error.message) };

  // Same-origin paths only, so `?next=` cannot become an open redirect.
  const next = parsed.data.next;
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
  redirect(target);
}

/**
 * Open an account when Supabase cannot send the confirmation email.
 *
 * OFF unless `AUTH_ALLOW_UNVERIFIED_SIGNUP=true`. It is a deliberate decision
 * by the school, not a default, because it does two things worth stating:
 *
 * It creates the user through the SERVICE ROLE, from a public form. CLAUDE.md
 * keeps that client away from unvalidated input, and this is the narrowest
 * exception it can be: the input has already been through the same Zod schema
 * the form used, the rate limiter has already let this caller through, the only
 * fields written are the address, the password and the two the trigger reads,
 * and it is reached only after Supabase itself has refused for this one reason.
 * No `role` is ever passed; `handle_new_user` decides that, as it does for an
 * ordinary sign-up.
 *
 * And it marks the address confirmed without anybody having proved they own it.
 * That is exactly what turning "Confirm email" off in Supabase does, and it is
 * the same trade: an address here unlocks nothing on its own. Access is decided
 * by entitlements and row-level security, which are granted by a payment, never
 * by an inbox.
 *
 * Returns an ActionState to show, or null when the account is open and the
 * caller should redirect. The redirect is left to the caller because it throws.
 */
async function openAccountWithoutEmail(
  input: { email: string; password: string; fullName: string; locale: string },
  cause: string,
): Promise<ActionState | null> {
  reportError('auth.unverifiedSignupFallback', new Error(cause), {
    note: 'AUTH_ALLOW_UNVERIFIED_SIGNUP is on; opening the account without confirmation',
  });

  const admin = createAdminClient();
  const { error: createError } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName, locale: input.locale },
  });

  if (createError) {
    return { ok: false, message: await authErrorMessage(createError.message) };
  }

  // Sign in on the ORDINARY client, so the session cookie belongs to this
  // browser. The admin client holds no session and sets no cookies by design.
  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });
  if (signInError) {
    // The account exists; only the automatic sign-in failed. Say so rather than
    // implying nothing happened and inviting them to register again.
    reportError('auth.fallbackSignIn', new Error(signInError.message));
    const t = await getTranslations('authErrors');
    return { ok: false, message: t('accountOpenedSignInFailed') };
  }

  return null;
}

export async function register(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const limited = await guard('register', 5);
  if (limited) return limited;

  const locale = await getLocale();
  const parsed = registerSchema.safeParse({
    fullName: formData.get('fullName'),
    email: formData.get('email'),
    password: formData.get('password'),
    passwordConfirm: formData.get('passwordConfirm'),
    locale,
    acceptTerms: formData.get('acceptTerms') === 'on',
  });
  if (!parsed.success) {
    return { ok: false, fieldErrors: await resolveFieldErrors(parsed.error.issues) };
  }
  if (!supabaseConfigured) return notConfigured();

  const supabase = await createClient();

  // Timed, because "registering is slow" has two possible causes and they are
  // not distinguishable from the outside. Supabase sends the confirmation
  // e-mail through the school's SMTP server INSIDE this call and does not
  // answer until the mail server does, so most of the wait is usually here —
  // but the alerts below are a second connection to the same host, and
  // guessing which dominates is how an afternoon gets spent on the wrong one.
  // One line in the Vercel log settles it.
  const startedAt = Date.now();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // Read by the handle_new_user trigger. It is client-supplied, so the
      // trigger validates the locale and ignores everything else in here —
      // notably any `role` claim.
      data: { full_name: parsed.data.fullName, locale: parsed.data.locale },
      emailRedirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent('/dashboard')}`,
      captchaToken: captchaTokenFrom(formData),
    },
  });
  console.info(`[auth] signUp took ${Date.now() - startedAt}ms`);

  // The office is told, after the response — by e-mail and as a push
  // notification on whatever device the school has subscribed. The student is
  // deliberately not written to here: the only student e-mail is the one sent
  // when the office approves the registration, so nobody is welcomed into a
  // space they cannot use yet.
  //
  // Both run in `after()`, which is the point: they are side effects, and the
  // student has no reason to wait for either. Before this, the sign-up held the
  // response open for a second SMTP connection — TCP, TLS, AUTH, DATA, QUIT to
  // a shared mail host — while the person stared at a spinner. `after()` runs
  // the block once the response is on its way and keeps the function alive for
  // it, so the push added here costs the student nothing at all.
  if (!error) {
    const notify = {
      fullName: parsed.data.fullName,
      email: parsed.data.email,
      userId: data.user?.id ?? '',
    };
    after(async () => {
      const alertsAt = Date.now();
      // allSettled, not all: one failing send must not skip the other.
      await Promise.allSettled([
        notifyOfficeOfRegistration(notify),
        notifyStaffOfRegistration(notify),
      ]);
      console.info(
        `[auth] registration alerts took ${Date.now() - alertsAt}ms (after the response)`,
      );
    });
  }

  if (error) {
    // The one failure that is not about this person and cannot be retried away:
    // Supabase could not send the confirmation email. If the school has said it
    // would rather open accounts than wait for the mail to work, do that.
    if (
      classifyAuthError(error.message) === 'emailSendFailed' &&
      process.env.AUTH_ALLOW_UNVERIFIED_SIGNUP === 'true'
    ) {
      const fallback = await openAccountWithoutEmail(parsed.data, error.message);
      if (fallback) return fallback;
      redirect('/dashboard');
    }
    return { ok: false, message: await authErrorMessage(error.message) };
  }

  // Whether a confirmation email is required is a Supabase setting, not
  // something this code gets to assume. With confirmation off — which is how a
  // school runs before it has its own mail domain — Supabase signs the person
  // in there and then and hands back a session. Sending them to "check your
  // inbox" would strand an account that is already open, waiting for a message
  // nobody sent.
  if (data.session) redirect('/dashboard');

  redirect(`/verify-email?email=${encodeURIComponent(parsed.data.email)}`);
}

export async function sendMagicLink(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const limited = await guard('magic', 5);
  if (limited) return limited;

  const parsed = magicLinkSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { ok: false, fieldErrors: await resolveFieldErrors(parsed.error.issues) };
  }
  if (!supabaseConfigured) return notConfigured();

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent('/dashboard')}`,
      captchaToken: captchaTokenFrom(formData),
    },
  });
  if (error) return { ok: false, message: await authErrorMessage(error.message) };

  const t = await getTranslations('auth');
  return { ok: true, message: t('magicLinkSent') };
}

export async function forgotPassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const limited = await guard('forgot', 5);
  if (limited) return limited;

  const parsed = forgotPasswordSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { ok: false, fieldErrors: await resolveFieldErrors(parsed.error.issues) };
  }

  const t = await getTranslations('auth');

  if (supabaseConfigured) {
    const supabase = await createClient();
    await supabase.auth.resetPasswordForEmail(parsed.data.email, {
      redirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent('/reset-password')}`,
      captchaToken: captchaTokenFrom(formData),
    });
  }

  // The same answer either way. Reporting "no such account" here would turn
  // the form into an account-enumeration oracle.
  return { ok: true, message: t('resetSent') };
}

export async function resetPassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const limited = await guard('reset', 10);
  if (limited) return limited;

  const parsed = resetPasswordSchema.safeParse({
    password: formData.get('password'),
    passwordConfirm: formData.get('passwordConfirm'),
  });
  if (!parsed.success) {
    return { ok: false, fieldErrors: await resolveFieldErrors(parsed.error.issues) };
  }
  if (!supabaseConfigured) return notConfigured();

  const supabase = await createClient();
  // The recovery link already established a session in /auth/callback, so this
  // updates the signed-in user rather than trusting a token posted in a form.
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { ok: false, message: await authErrorMessage(error.message) };

  redirect('/login?reset=1');
}

export async function signOut(): Promise<void> {
  if (supabaseConfigured) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect('/');
}
