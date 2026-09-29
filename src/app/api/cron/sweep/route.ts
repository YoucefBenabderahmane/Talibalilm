import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { supabaseConfigured, siteUrl } from '@/lib/env';
import { reportError } from '@/lib/observability/report';

/**
 * The heavy clients are imported WHERE THEY ARE USED, not at the top.
 *
 * This endpoint runs every fifteen minutes, and most runs have nothing to do:
 * no expired video, no installment due. Importing the S3 client, nodemailer
 * and web-push at module scope made every one of those runs pay their startup
 * cost for nothing — on a plan where function CPU is the scarce resource.
 * `await import()` inside the branch that needs it keeps the empty run cheap.
 */

/**
 * The housekeeping the shop needs to stay honest.
 *
 * Two jobs, deliberately in one endpoint because they must both run and
 * neither is worth its own schedule:
 *
 *   * Cancel checkouts nobody came back to, and give back the coupon and pack
 *     redemption they were holding. A student who closes the tab on PayPal's
 *     page never reaches our cancel route, so without this their single-use
 *     code is gone for good.
 *   * Mark expired entitlements expired. Purely cosmetic —
 *     `has_course_access` already ignores them on the clock — but it keeps the
 *     admin listings truthful and the partial indexes small.
 *   * Delete lesson videos whose retention has run out. This one cannot be a
 *     Postgres job: the row is the cheap half, and the object in R2 — the half
 *     that is actually billed by the gigabyte-month — can only be removed by
 *     code that holds the bucket credentials.
 *
 * Protected by a shared secret rather than a session: Vercel Cron calls this
 * with no user. Without `CRON_SECRET` set it refuses outright, because an open
 * endpoint that cancels orders is worse than a job that does not run.
 */
export const dynamic = 'force-dynamic';

function authorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
  const header = request.headers.get('authorization') ?? '';
  const offered = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (offered.length !== secret.length) return false;

  // Constant-time. A length check leaks nothing useful; a character-by-
  // character early return would.
  let diff = 0;
  for (let i = 0; i < secret.length; i += 1) {
    diff |= offered.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Tell a student their installment is due.
 *
 * Both channels, best-effort: push to their devices and an e-mail, because a
 * notification the browser never showed is not a reminder. A failure is
 * reported and the sweep carries on — the next run has its own claim, and one
 * undeliverable e-mail must not stop the other students being told.
 */
/**
 * Remove the accounts that never confirmed and never bought.
 *
 * The list comes from the database (see 20260917110000) and the deletion goes
 * through the auth admin API, which is the only thing that can remove a user.
 * Failures are counted, not thrown: one stuck account must not stop the rest,
 * and the next run will try again.
 */
async function purgeUnconfirmedUsers(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<number> {
  const { data: stale, error } = await supabase.rpc('unconfirmed_users', {
    older_than: '2 days',
  });
  if (error) {
    reportError('cron.unconfirmed', error, { note: 'nothing deleted this run' });
    return 0;
  }
  if (!stale || stale.length === 0) return 0;

  let deleted = 0;
  for (const account of stale) {
    try {
      const { error: removeError } = await supabase.auth.admin.deleteUser(account.id);
      if (removeError) throw removeError;
      deleted += 1;
    } catch (cause) {
      reportError('cron.unconfirmed.delete', cause, { userId: account.id });
    }
  }
  return deleted;
}

async function sendInstallmentReminders(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<number> {
  const { data: notices, error } = await supabase.rpc('claim_due_installment_notices');
  if (error) {
    reportError('cron.installments', error, { note: 'reminders not sent this run' });
    return 0;
  }
  if (!notices || notices.length === 0) return 0;

  // Only now is any of this needed — see the note beside the imports.
  const [{ notifyUser }, { sendMail }, { paymentDue }] = await Promise.all([
    import('@/lib/push/server'),
    import('@/lib/email/send'),
    import('@/lib/email/templates'),
  ]);

  let sent = 0;
  for (const notice of notices) {
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, locale')
        .eq('id', notice.user_id)
        .maybeSingle();

      const { data: account } = await supabase.auth.admin.getUserById(notice.user_id);
      const email = account?.user?.email ?? null;
      const locale = profile?.locale === 'en' ? 'en' : 'fr';
      const overdue = notice.kind === 'due-0';

      const amount = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: notice.amount_cents % 100 === 0 ? 0 : 2,
      }).format(notice.amount_cents / 100);
      const due = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(
        new Date(notice.due_at),
      );

      await notifyUser(notice.user_id, {
        title: overdue
          ? locale === 'fr'
            ? 'Échéance à régler'
            : 'Installment to settle'
          : locale === 'fr'
            ? 'Prochaine échéance'
            : 'Next installment',
        body: overdue
          ? locale === 'fr'
            ? `${amount} était due le ${due}. Votre accès est suspendu jusqu’au règlement.`
            : `${amount} was due on ${due}. Access is suspended until it is settled.`
          : locale === 'fr'
            ? `${amount} à régler le ${due}.`
            : `${amount} due on ${due}.`,
        url: '/dashboard',
        tag: `installment-${notice.installment_id}-${notice.kind}`,
      });

      if (email) {
        await sendMail(
          paymentDue({
            to: email,
            fullName: profile?.full_name ?? '',
            locale,
            amount,
            due,
            spaceUrl: `${siteUrl()}/dashboard`,
            overdue,
          }),
        );
      }
      sent += 1;
    } catch (cause) {
      reportError('cron.installment', cause, { installmentId: notice.installment_id });
    }
  }

  return sent;
}

export async function GET(request: NextRequest) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  }
  if (!supabaseConfigured) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  const supabase = createAdminClient();

  // The two money-critical jobs. Their failure used to return before anything
  // else ran — one missing migration stopped the spam purge, the reminders,
  // the video retention and the room cleanup with it, and the response said
  // only "sweep_failed". Now every job runs and the failures are named; the
  // 500 stays because the workflow watches the status code.
  const { data: swept, error: sweepError } = await supabase.rpc('expire_pending_orders', {
    older_than: '30 minutes',
  });
  if (sweepError) reportError('cron.expirePendingOrders', sweepError);

  const { data: expired, error: expiryError } = await supabase.rpc('expire_entitlements');
  if (expiryError) reportError('cron.expireEntitlements', expiryError);

  const videosPurged = await purgeExpiredVideos(supabase);

  // Installment reminders: a week before, the day before, and on the day. The
  // claim happens inside the RPC — `on conflict do nothing` — so two runs
  // racing each other send each reminder once.
  const reminders = await sendInstallmentReminders(supabase);

  // Spam registrations: never confirmed, never bought, older than two days.
  // Two days is long enough that a student who mistyped their address can ask
  // for a new link, and short enough that the list stays clean.
  const unconfirmedPurged = await purgeUnconfirmedUsers(supabase);

  // Rooms nobody closed: five hours is the school's ceiling for one class, and
  // a forgotten tab must not leave a class "live" for a week.
  const { data: liveClosed, error: liveError } = await supabase.rpc('end_stale_live_sessions', {
    max_hours: 5,
  });
  if (liveError) reportError('cron.liveStale', liveError, { note: 'rooms left open this run' });

  // Rolled-over rate-limit windows are dead weight once past. Pruning them is
  // pure housekeeping — a failure here must not fail the sweep that matters.
  const { data: pruned, error: pruneError } = await supabase.rpc('prune_rate_limits');
  if (pruneError) console.error('[cron] rate-limit prune failed:', pruneError.message);

  const result = {
    ordersCancelled: swept ?? 0,
    entitlementsExpired: expired ?? 0,
    rateWindowsPruned: pruned ?? 0,
    videosPurged,
    installmentReminders: reminders,
    unconfirmedPurged,
    liveSessionsClosed: liveClosed ?? 0,
  };

  const failures: string[] = [];
  if (sweepError) failures.push('expire_pending_orders');
  if (expiryError) failures.push('expire_entitlements');

  if (failures.length > 0) {
    return NextResponse.json(
      { ...result, error: 'sweep_failed', failed: failures },
      { status: 500 },
    );
  }

  // Any count above zero, not only the three this condition started with: a
  // run that only purged spam or only sent reminders used to log nothing.
  if (Object.values(result).some((count) => count > 0)) {
    console.info('[cron] sweep:', result);
  }
  return NextResponse.json(result);
}

/**
 * Delete uploaded videos the school asked us to forget.
 *
 * The object goes first and the row second, deliberately. The other order can
 * leave an object no row points at — unreachable, undeletable by any screen,
 * and still billed every month. This order can at worst leave a row pointing at
 * an object that is already gone, which shows the student an honest "video
 * unavailable" and is fixed by pressing Remove.
 *
 * One at a time, and a failure on one does not stop the rest: a single object
 * R2 refuses must not strand every other expired video behind it.
 */
async function purgeExpiredVideos(supabase: ReturnType<typeof createAdminClient>): Promise<number> {
  const { data: due, error } = await supabase
    .from('lesson_content')
    .select('lesson_id, video_id')
    .eq('video_provider', 'r2')
    .not('video_expires_at', 'is', null)
    .lte('video_expires_at', new Date().toISOString())
    .limit(50);

  if (error) {
    console.error('[cron] expired-video lookup failed:', error.message);
    return 0;
  }
  if (!due || due.length === 0) return 0;

  // The S3 client is only worth loading when there is an object to remove.
  const { deleteObject } = await import('@/lib/storage/r2');

  let removed = 0;
  for (const row of due) {
    if (row.video_id) await deleteObject(row.video_id);
    const { error: clearError } = await supabase
      .from('lesson_content')
      .update({
        video_provider: 'none',
        video_id: null,
        video_bytes: 0,
        video_uploaded_at: null,
        video_expires_at: null,
      })
      .eq('lesson_id', row.lesson_id);
    if (clearError) {
      console.error('[cron] clearing video row failed:', clearError.message);
      continue;
    }
    removed += 1;
  }
  return removed;
}
