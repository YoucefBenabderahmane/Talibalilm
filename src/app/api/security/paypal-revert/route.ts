import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { supabaseConfigured, siteUrl } from '@/lib/env';
import { verifyRevertToken } from '@/lib/security/pin';
import { reportError } from '@/lib/observability/report';
import { sendMail, officeInbox } from '@/lib/email/send';
import { securityAlert } from '@/lib/email/templates';
import { escapeHtml } from '@/lib/email/escape';
import { institut } from '@/lib/content/institut';

/**
 * "It was not me."
 *
 * One click from the alert e-mail, and it does three things in this order:
 *
 *   1. Clears the PayPal credentials and switches online payment OFF. The
 *      money path is closed before anybody investigates — clearing rather than
 *      restoring the previous values, because the previous values are exactly
 *      what an attacker was moving the money away from.
 *   2. Sends the account holder a password-reset e-mail. Until that password
 *      is changed, the stolen session is still a session.
 *   3. Tells the office, with what to do next.
 *
 * The link is signed (HMAC over the admin's id and the moment of the change)
 * and works from the mailbox, with no session — the person who needs it may
 * not be able to sign in any more.
 *
 * Two steps, not one. The link from the mail is a GET, and GETs are fetched by
 * things that are not the reader: a mail scanner checking links for malware,
 * a preview, a forward to a colleague. A GET that wiped the credentials was
 * one such fetch away from turning off the school's payments for a week. So
 * the GET shows what the button will do and asks; the POST behind the button
 * does it. The token is checked on both.
 */

function params(request: NextRequest, form: FormData | null) {
  const pick = (name: string) => {
    const value = form?.get(name) ?? request.nextUrl.searchParams.get(name);
    return typeof value === 'string' && value ? value : null;
  };
  return { userId: pick('u'), token: pick('t') };
}

/** The checks both steps share: configured, complete, and signed by us. */
function refusal(userId: string | null, token: string | null): NextResponse | null {
  const secret = process.env.STEPUP_SECRET?.trim();
  if (!supabaseConfigured || !secret || !userId || !token) {
    return NextResponse.json({ error: 'unavailable' }, { status: 400 });
  }
  if (!verifyRevertToken(token, userId, secret)) {
    // A forged or expired link is worth a note: the second is what happens
    // when somebody opens the alert a month later.
    reportError('security.revert.invalid', new Error('revert token refused'), { userId });
    return NextResponse.json({ error: 'invalid' }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const { userId, token } = params(request, null);
  const refused = refusal(userId, token);
  if (refused) return refused;

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Confirmer — Institut Talib Alim</title>
<style>
  body{margin:0;background:#f2f7f6;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#16221f}
  main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5ebe9;border-radius:14px;padding:28px}
  .brand{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#128a68;font-weight:600}
  h1{margin:12px 0 0;font-size:22px}
  p{color:#5f736d;line-height:1.6}
  button{margin-top:8px;background:#b91c1c;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-size:15px;font-weight:600;cursor:pointer}
</style>
</head>
<body>
<main>
  <div class="brand">Institut Talib Alim</div>
  <h1>Couper le paiement en ligne ?</h1>
  <p>Ce bouton vide les identifiants PayPal du site, désactive le paiement en ligne et envoie un
  e-mail de réinitialisation du mot de passe au compte administrateur. À n’utiliser que si la
  modification signalée dans l’e-mail n’était pas la vôtre.</p>
  <form method="post" action="/api/security/paypal-revert">
    <input type="hidden" name="u" value="${escapeHtml(userId)}">
    <input type="hidden" name="t" value="${escapeHtml(token)}">
    <button type="submit">Oui, couper le paiement en ligne</button>
  </form>
  <p>Si vous n’êtes pas à l’origine de cette page, fermez-la : rien n’a été modifié.</p>
</main>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const { userId, token } = params(request, form);
  const refused = refusal(userId, token);
  if (refused || !userId) return refused ?? NextResponse.json({ error: 'invalid' }, { status: 401 });

  const admin = createAdminClient();

  const { error } = await admin
    .from('payment_settings')
    .update({
      client_id: '',
      client_secret: '',
      webhook_id: '',
      enabled: false,
    })
    .eq('id', true);

  if (error) {
    reportError('security.revert.save', error, { userId });
    return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  }

  const { data: account } = await admin.auth.admin.getUserById(userId);
  const email = account?.user?.email ?? null;

  if (email) {
    const { error: resetError } = await admin.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl()}/reset-password`,
    });
    if (resetError) reportError('security.revert.reset', resetError, { userId });
  }

  try {
    await sendMail(
      securityAlert({
        to: officeInbox(institut.email),
        action: 'Paiement en ligne coupé (signalement)',
        actor: email ?? userId,
        detail:
          'Les identifiants PayPal ont été vidés et le paiement en ligne désactivé. ' +
          'Changez le mot de passe du compte administrateur, puis remettez les identifiants depuis Administration → Paiement.',
        revertUrl: null,
      }),
    );
  } catch (cause) {
    reportError('security.revert.mail', cause, { userId });
  }

  // 303, so the browser follows with a GET rather than re-posting the form.
  return NextResponse.redirect(`${siteUrl()}/admin/payments?security=reverted`, 303);
}
