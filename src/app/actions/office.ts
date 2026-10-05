'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/guards';
import { reportError } from '@/lib/observability/report';
import { slugifyBatch } from '@/lib/commerce/batch';
import { deleteObject } from '@/lib/storage/r2';
import { sendMail, officeInbox } from '@/lib/email/send';
import { officeApprovalNotice, studentApproved } from '@/lib/email/templates';
import { institut } from '@/lib/content/institut';
import { siteUrl } from '@/lib/env';
import type { AdminState } from '@/app/actions/admin';
import { errorDetail } from '@/lib/supabase/error-detail';

/**
 * Office operations — grant, revoke, and cash codes.
 *
 * These call security-definer RPCs through the ordinary authenticated client,
 * never the service role. The `is_admin()` check lives inside each RPC and the
 * audit row it writes names `auth.uid()`, so the trail records the real person
 * rather than an anonymous privileged write. `requireAdmin()` here is the
 * courtesy guard that keeps a non-admin from reaching the action at all; the
 * RPC is the control.
 */

const OK: AdminState = { ok: true };

async function admin() {
  if (!supabaseConfigured) throw new Error('unavailable');
  await requireAdmin();
  return createClient();
}

const grantSchema = z.object({
  userId: z.string().uuid(),
  scope: z.enum(['course', 'cursus', 'site']),
  courseId: z.string().uuid().nullable(),
  cursusId: z.string().uuid().nullable(),
  yearIndex: z.coerce.number().int().min(1).max(10),
  delivery: z.enum(['presentiel', 'online']),
  days: z.coerce.number().int().min(1).max(3650),
  reason: z.string().trim().min(3).max(200),
});

export async function grantEntitlement(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = grantSchema.safeParse({
    userId: formData.get('userId'),
    scope: formData.get('scope'),
    courseId: (formData.get('courseId') as string) || null,
    cursusId: (formData.get('cursusId') as string) || null,
    yearIndex: formData.get('yearIndex') || 1,
    delivery: formData.get('delivery'),
    days: formData.get('days') || 365,
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  const g = parsed.data;
  // Scope determines which target the RPC reads; the other is passed null.
  if (g.scope === 'course' && !g.courseId) return { ok: false, error: 'targetRequired' };
  if (g.scope === 'cursus' && !g.cursusId) return { ok: false, error: 'targetRequired' };

  const supabase = await admin();
  const { error } = await supabase.rpc('admin_grant_entitlement', {
    target_user: g.userId,
    target_scope: g.scope,
    course_id: g.scope === 'course' ? g.courseId : null,
    cursus_id: g.scope === 'cursus' ? g.cursusId : null,
    year_index: g.yearIndex,
    delivery: g.delivery,
    days: g.days,
    reason: g.reason,
  });
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/students/[id]', 'page');
  return OK;
}

export async function revokeEntitlement(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const parsed = z
    .object({ entitlementId: z.string().uuid(), reason: z.string().trim().min(3).max(200) })
    .safeParse({ entitlementId: formData.get('entitlementId'), reason: formData.get('reason') });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  const supabase = await admin();
  const { data, error } = await supabase.rpc('admin_revoke_entitlement', {
    entitlement_id: parsed.data.entitlementId,
    reason: parsed.data.reason,
  });
  if (error || data !== true) return { ok: false, error: 'saveFailed' };

  revalidatePath('/[locale]/admin/students/[id]', 'page');
  return OK;
}

export async function voidCoupon(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({ couponId: z.string().uuid(), reason: z.string().trim().max(200).default('') })
    .safeParse({ couponId: formData.get('couponId'), reason: formData.get('reason') ?? '' });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await admin();
  const { error } = await supabase.rpc('admin_void_coupon', {
    coupon_id: parsed.data.couponId,
    reason: parsed.data.reason,
  });
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/coupons', 'page');
  return OK;
}

/**
 * Delete coupon codes outright, from the list's selection.
 *
 * The office asked for used codes to leave the list, and a code is not a
 * record of a sale: `orders.coupon_id` and `installments.coupon_id` are both
 * `on delete set null`, so the money rows survive and only the link to the
 * code goes. The RPC is the control and the audit — one `coupon.delete` row
 * per code, written from the rows the DELETE returns, because after it there
 * is nothing left to name.
 */
export async function deleteCoupons(ids: string[]): Promise<AdminState> {
  const parsed = z.array(z.string().uuid()).min(1).max(500).safeParse(ids);
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await admin();
  const { error } = await supabase.rpc('admin_delete_coupons', { ids: parsed.data });
  if (error) {
    reportError('coupons.delete', error);
    return {
      ok: false,
      error: error.code === '42501' ? 'notAdmin' : 'saveFailed',
      detail: errorDetail(error),
    };
  }

  revalidatePath('/[locale]/admin/coupons', 'page');
  return OK;
}

/**
 * Correct a student's details.
 *
 * Through the ordinary client, so `profiles_update_admin` is the control — and
 * the column grants are the reason this cannot quietly become something worse:
 * `authenticated` may write full_name, phone and locale and nothing else, so
 * even a mistake here could not promote anyone to staff.
 *
 * The email is not editable from this screen. It is the login, it lives in
 * auth.users, and changing it silently would lock a student out of an account
 * they can still see the password for.
 */
export async function updateStudent(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({
      userId: z.string().uuid(),
      fullName: z.string().trim().max(120).default(''),
      phone: z.string().trim().max(32).default(''),
      phoneLandline: z.string().trim().max(32).default(''),
      locale: z.enum(['fr', 'en']).default('fr'),
      // The enrolment form's fields. The office can correct a typo a student
      // made; the shape constraints in the database still hold.
      civility: z.enum(['', 'madame', 'monsieur']).default(''),
      firstName: z.string().trim().max(60).default(''),
      lastName: z.string().trim().max(60).default(''),
      birthDate: z
        .string()
        .trim()
        .regex(/^$|^\d{4}-\d{2}-\d{2}$/)
        .default(''),
      address: z.string().trim().max(200).default(''),
      postalCode: z.string().trim().max(16).default(''),
      city: z.string().trim().max(120).default(''),
      department: z.string().trim().max(120).default(''),
    })
    .safeParse({
      userId: formData.get('userId'),
      fullName: formData.get('fullName') ?? '',
      phone: formData.get('phone') ?? '',
      phoneLandline: formData.get('phoneLandline') ?? '',
      locale: formData.get('locale') ?? 'fr',
      civility: formData.get('civility') ?? '',
      firstName: formData.get('firstName') ?? '',
      lastName: formData.get('lastName') ?? '',
      birthDate: formData.get('birthDate') ?? '',
      address: formData.get('address') ?? '',
      postalCode: formData.get('postalCode') ?? '',
      city: formData.get('city') ?? '',
      department: formData.get('department') ?? '',
    });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await admin();
  const { error } = await supabase
    .from('profiles')
    .update({
      full_name: parsed.data.fullName,
      // The constraint wants null rather than an empty string.
      phone: parsed.data.phone || null,
      phone_landline: parsed.data.phoneLandline || null,
      locale: parsed.data.locale,
      civility: parsed.data.civility || null,
      first_name: parsed.data.firstName,
      last_name: parsed.data.lastName,
      birth_date: parsed.data.birthDate || null,
      address: parsed.data.address,
      postal_code: parsed.data.postalCode,
      city: parsed.data.city,
      department: parsed.data.department,
    })
    .eq('id', parsed.data.userId);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/students/[id]', 'page');
  revalidatePath('/[locale]/admin/students', 'page');
  return OK;
}

/**
 * Swap a wrongly bought access for the right one.
 *
 * Access only: the money is untouched, and the replacement keeps the days that
 * were left on what it replaces. The RPC is the control and the audit — it
 * checks `is_admin()`, refuses an entitlement this order did not buy, and
 * writes the correction row the order screen shows.
 */
export async function correctOrder(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({
      orderId: z.string().uuid(),
      entitlementId: z.string().uuid(),
      target: z.string().min(1),
      reason: z.string().trim().min(3).max(500),
    })
    .safeParse({
      orderId: formData.get('orderId'),
      entitlementId: formData.get('entitlementId'),
      target: formData.get('target'),
      reason: formData.get('reason'),
    });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  // `course:<uuid>` or `cursus:<uuid>:<year>` — the target is one choice in
  // the form, and this is what it means.
  const [kind, id, year] = parsed.data.target.split(':');
  if ((kind !== 'course' && kind !== 'cursus') || !id) {
    return { ok: false, error: 'targetRequired' };
  }

  const supabase = await admin();
  const { error } = await supabase.rpc('admin_correct_order', {
    target_order: parsed.data.orderId,
    old_entitlement: parsed.data.entitlementId,
    new_course: kind === 'course' ? id : null,
    new_cursus: kind === 'cursus' ? id : null,
    new_year: kind === 'cursus' ? Number(year ?? 1) || 1 : null,
    reason: parsed.data.reason,
  });

  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/orders/[id]', 'page');
  revalidatePath('/[locale]/admin/students/[id]', 'page');
  return OK;
}

/**
 * Let a registration in, or put it back in the queue.
 *
 * Shared by the approval button and the confirm-e-mail action, because
 * confirming an address IS activation now — the two must leave the same row
 * and the same messages.
 *
 * The RPC is the control and the audit: it checks `is_admin()`, records who
 * decided and when, and returns the student's e-mail only when something
 * actually changed — so a second press cannot send a second message. The two
 * e-mails are the loop closing: the student learns they can enrol, and the
 * office keeps a copy in its own mailbox.
 *
 * Nothing here is allowed to fail the decision, and nothing here may delay it
 * either. The decision is committed by the RPC above; the profile read and the
 * two SMTP connections are side effects, and holding the admin's button open
 * for them is how approving a registration came to feel broken. They run in
 * `after()`, once the response is on its way.
 */
async function applyApproval(userId: string, approve: boolean): Promise<AdminState> {
  const supabase = await admin();
  const { data: email, error } = await supabase.rpc('admin_set_approval', {
    uid: userId,
    approve,
  });
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  // Null means it was already in that state — nothing to announce.
  if (email) {
    after(async () => {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, locale')
        .eq('id', userId)
        .maybeSingle();
      const fullName = profile?.full_name ?? '';

      // Only an approval is good news. Sending "your registration is approved"
      // to somebody who was just put back in the queue was worse than silence.
      if (approve) {
        try {
          await sendMail(
            studentApproved({
              to: email,
              fullName,
              locale: profile?.locale ?? 'fr',
              spaceUrl: `${siteUrl()}/dashboard`,
            }),
          );
        } catch (cause) {
          reportError('approval.student.mail', cause, { userId });
        }
      }

      try {
        await sendMail(
          officeApprovalNotice({
            to: officeInbox(institut.email),
            fullName,
            email,
            approved: approve,
          }),
        );
      } catch (cause) {
        reportError('approval.office.mail', cause, { userId });
      }
    });
  }

  return OK;
}

export async function setStudentApproval(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const parsed = z
    .object({ userId: z.string().uuid(), approve: z.enum(['yes', 'no']) })
    .safeParse({ userId: formData.get('userId'), approve: formData.get('approve') });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const state = await applyApproval(parsed.data.userId, parsed.data.approve === 'yes');
  if (!state.ok) return state;

  revalidatePath('/[locale]/admin/students/[id]', 'page');
  revalidatePath('/[locale]/admin/students', 'page');
  revalidatePath('/[locale]/admin', 'page');
  return OK;
}

/**
 * Delete a student account outright.
 *
 * Only for an account that never bought anything — a test signup, a duplicate,
 * a mistyped address. `orders.user_id` is `on delete restrict`, so the database
 * refuses to remove anyone whose purchases would be orphaned, and this checks
 * first so the office gets a sentence explaining why rather than a failed save.
 * For a student who did buy, erasure is the right tool: it scrubs the person and
 * keeps the sale.
 *
 * Deleting the auth user is what removes them; the profile, entitlements and
 * progress follow by cascade.
 */
export async function deleteStudent(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z.object({ userId: z.string().uuid() }).safeParse({
    userId: formData.get('userId'),
  });
  if (!parsed.success) return { ok: false, error: 'invalid' };
  const { userId } = parsed.data;

  const supabase = await admin();

  // Never a colleague. Staff accounts are removed deliberately, not from the
  // student list.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  if (!profile) return { ok: false, error: 'saveFailed' };
  if (profile.role !== 'student') return { ok: false, error: 'studentIsStaff' };

  const { count } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if ((count ?? 0) > 0) return { ok: false, error: 'studentHasOrders' };

  try {
    const service = createAdminClient();
    const { error } = await service.auth.admin.deleteUser(userId);
    if (error) throw error;
  } catch (cause) {
    reportError('students.delete', cause, { userId });
    return { ok: false, error: 'saveFailed', detail: errorDetail(cause) };
  }

  revalidatePath('/[locale]/admin/students', 'page');
  return OK;
}

/**
 * Confirm a student's e-mail address by hand, and activate the account.
 *
 * Supabase refuses a sign-in until the address is confirmed, and confirming it
 * means receiving a message. When the mail path is broken — an unverified
 * sending domain, a provider over its limit — the student is stranded, and no
 * amount of retrying by them fixes something that is not theirs to fix. The
 * office should be able to open the account instead of waiting.
 *
 * One press does the whole registration: the address is confirmed, the account
 * is approved (the audited RPC, with its two e-mails) and the "Nouveau" flag is
 * cleared. Two buttons for one decision left students who could sign in but
 * not buy, because the second press was easy to forget.
 *
 * The service role is the only way to touch `auth.users`, and this is one of
 * the few legitimate uses of it: `requireAdmin()` has already passed, the id
 * has been through Zod, and the row is checked to be a student before anything
 * is written — a staff account is not activated from the student list.
 *
 * Idempotent, every step of it. Confirming an already-confirmed address changes
 * nothing, approving an approved account returns no e-mail to send, and marking
 * a seen registration writes no second audit row — so the button can sit on
 * every row of the list without the page having to read `auth.users`.
 *
 * The confirmation itself is NOT in `admin_audit`, and the reason is worth
 * stating rather than leaving as an oversight: `record_admin_action` is revoked
 * from `public` and granted to nobody, so it is callable only from inside
 * another SECURITY DEFINER function. Auditing it properly means a definer
 * function of its own. The approval it now performs IS audited.
 */
export async function confirmStudentEmail(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const parsed = z.object({ userId: z.string().uuid() }).safeParse({
    userId: formData.get('userId'),
  });
  if (!parsed.success) return { ok: false, error: 'invalid' };
  const { userId } = parsed.data;

  const supabase = await admin();

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  if (!profile) return { ok: false, error: 'saveFailed' };
  if (profile.role !== 'student') return { ok: false, error: 'studentIsStaff' };

  try {
    const service = createAdminClient();
    const { error } = await service.auth.admin.updateUserById(userId, { email_confirm: true });
    if (error) throw error;
  } catch (cause) {
    reportError('students.confirmEmail', cause, { userId });
    return { ok: false, error: 'saveFailed', detail: errorDetail(cause) };
  }

  // Activation, through the same audited RPC the approval button uses. A
  // failure here does not undo the confirmation — retrying is idempotent.
  const approved = await applyApproval(userId, true);
  if (!approved.ok) return approved;

  // The registration is dealt with, so the notification goes too. A failure
  // here is a badge that stays, not an account that did not open.
  const { error: seenError } = await supabase.rpc('admin_mark_reviewed', { uid: userId });
  if (seenError) reportError('students.confirmEmail.markReviewed', seenError, { userId });

  revalidatePath('/[locale]/admin/students/[id]', 'page');
  revalidatePath('/[locale]/admin/students', 'page');
  revalidatePath('/[locale]/admin', 'page');
  return OK;
}

/**
 * Erase a student on request (GDPR B9).
 *
 * Two halves make one erasure. The RPC scrubs everything in `public` that names
 * the person — profile and live access — as the admin's own session, so the
 * audit records who ran it. Then the service-role Admin API scrubs the parts
 * only the auth admin may touch: the email becomes an unroutable token, the
 * metadata is emptied, and the login is banned so a dangling session cannot be
 * used. The order matters — the RPC is the authorisation gate, so nothing is
 * scrubbed in `auth` until it has said yes.
 *
 * The orders stay. `orders.user_id` is `on delete restrict` for exactly this
 * reason: the sale is the school's record, and it now points at a user who is
 * no longer identifiable.
 */
export async function anonymiseStudent(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({ userId: z.string().uuid(), reason: z.string().trim().min(3).max(200) })
    .safeParse({ userId: formData.get('userId'), reason: formData.get('reason') });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  const { userId, reason } = parsed.data;

  // Read the photo's key BEFORE the scrub clears it: Postgres cannot reach R2,
  // so the object is this action's to delete, and after the RPC the pointer is
  // gone.
  const adminClient = createAdminClient();
  const { data: profileRow } = await adminClient
    .from('profiles')
    .select('avatar_key')
    .eq('id', userId)
    .maybeSingle();

  const supabase = await admin();
  const { data, error } = await supabase.rpc('admin_anonymise_user', {
    target_user: userId,
    reason,
  });
  if (error || data !== true) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  // Best-effort: the person's photo should not survive the erasure, but a
  // storage hiccup must not fail the erasure that has already committed.
  if (profileRow?.avatar_key) await deleteObject(profileRow.avatar_key);

  // The email and login live in auth.users, which only the auth admin may
  // write. `.invalid` is a reserved, unroutable TLD, so the token can never be
  // mistaken for a real address or receive mail.
  try {
    const service = createAdminClient();
    const { error: authError } = await service.auth.admin.updateUserById(userId, {
      email: `anonymised+${userId}@deleted.invalid`,
      phone: '',
      user_metadata: {},
      // A very long ban, standing in for "permanent": the person is gone, so no
      // future sign-in should succeed on this account.
      ban_duration: '876000h',
    });
    if (authError) throw authError;
  } catch (cause) {
    // The public-schema scrub already committed. Surface the failure so the
    // office retries — the whole operation is idempotent, so a second run
    // simply finishes the auth half.
    reportError('gdpr.anonymise.auth', cause, { userId });
    return { ok: false, error: 'partialErasure', detail: errorDetail(cause) };
  }

  revalidatePath('/[locale]/admin/students/[id]', 'page');
  revalidatePath('/[locale]/admin/students', 'page');
  return OK;
}

const couponBatchSchema = z
  .object({
    quantity: z.coerce.number().int().min(1).max(500),
    kind: z.enum(['office', 'percent', 'amount']),
    percentOff: z.coerce.number().int().min(1).max(100).nullable(),
    amountOff: z.coerce.number().min(0).nullable(),
    maxRedemptions: z.coerce.number().int().min(1).max(100000),
    // Normalised, not rejected: "October 2026" becomes october-2026 rather than
    // a red sentence next to the button that does not say which field it means.
    batch: z.string().trim().max(120).transform(slugifyBatch),
  })
  .refine((v) => v.kind !== 'percent' || v.percentOff !== null, { message: 'percentRequired' })
  .refine((v) => v.kind !== 'amount' || (v.amountOff !== null && v.amountOff > 0), {
    message: 'amountRequired',
  });

export interface GenerateState extends AdminState {
  /** Returned once, here — a code is worth nothing after it can be read back. */
  codes?: string[];
}

export async function generateCoupons(
  _prev: GenerateState,
  formData: FormData,
): Promise<GenerateState> {
  const parsed = couponBatchSchema.safeParse({
    quantity: formData.get('quantity') || 1,
    kind: formData.get('kind'),
    percentOff: (formData.get('percentOff') as string) || null,
    amountOff: (formData.get('amountOff') as string) || null,
    maxRedemptions: formData.get('maxRedemptions') || 1,
    batch: formData.get('batch') ?? '',
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  const c = parsed.data;
  const supabase = await admin();
  const { data, error } = await supabase.rpc('admin_generate_coupons', {
    quantity: c.quantity,
    // An office code is 100% off; the other kinds carry their own discount.
    percent_off: c.kind === 'office' ? 100 : c.kind === 'percent' ? c.percentOff : null,
    amount_off_cents: c.kind === 'amount' ? Math.round((c.amountOff ?? 0) * 100) : null,
    max_redemptions: c.maxRedemptions,
    is_office: c.kind === 'office',
    batch: c.batch,
    // No prefix: the office asked for plain codes, and the generator's own
    // random suffix is what makes them unique.
    code_prefix: '',
    expires_at: null,
  });
  if (error || !data) {
    // "Enregistrement impossible" told the admin nothing and cost two rounds of
    // guessing, so the real cause is both logged and — where the code is
    // unambiguous — said out loud. These three are the ones that actually
    // happen; anything else stays generic rather than inventing a diagnosis.
    reportError('coupons.generate', error, { quantity: c.quantity, kind: c.kind });

    const code = error?.code ?? '';
    if (code === 'PGRST202' || code === '42883') {
      // PostgREST cannot find the function. That has TWO causes and they need
      // different fixes: the migration was never applied here, or it was and
      // PostgREST is still answering from a cached picture of the schema —
      // which is ordinary right after running DDL in the SQL editor. Saying
      // only the first sent someone to re-run a file they had already run.
      // The message names both and gives the reload command.
      return { ok: false, error: 'couponFunctionMissing', detail: errorDetail(error) };
    }
    if (code === '23502') {
      // A NOT NULL violation inside the generator means the first version of
      // `admin_generate_coupons` is still installed — the one whose empty
      // prefix produced a NULL code. The fix migration has not been run here.
      return { ok: false, error: 'couponFunctionOutdated', detail: errorDetail(error) };
    }
    if (code === '42501') return { ok: false, error: 'notAdmin', detail: errorDetail(error) };
    return { ok: false, error: 'saveFailed', detail: errorDetail(error) };
  }

  revalidatePath('/[locale]/admin/coupons', 'page');
  return { ok: true, codes: data };
}
