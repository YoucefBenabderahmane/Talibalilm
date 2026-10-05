import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured, siteUrl } from '@/lib/env';
import { institut } from '@/lib/content/institut';
import { officeInbox, sendMail } from '@/lib/email/send';
import { newRegistration } from '@/lib/email/templates';
import { reportError } from '@/lib/observability/report';

/**
 * Telling the office that somebody has registered.
 *
 * This used to be an approval gate — a new account could not reach the
 * checkout until an admin let it in. It is now purely a NOTIFICATION: an
 * e-mail to the school's mailbox and a count for the badge in the admin
 * sidebar. Nothing here decides who may buy or read anything; RLS does that,
 * and it did so before this file existed.
 */

/**
 * How many registrations nobody has opened yet, for the badge on the admin
 * shell. Staff-only inside the function, so a student calling it gets 0.
 */
export async function unreviewedStudentCount(): Promise<number> {
  if (!supabaseConfigured) return 0;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('unreviewed_student_count', {});
  if (error) return 0;
  return typeof data === 'number' ? data : 0;
}

/**
 * How many accounts are waiting to be approved, for the sidebar badge.
 *
 * Distinct from `unreviewedStudentCount`: "seen" is the office acknowledging a
 * registration, "approved" is letting it buy. The badge answers the second,
 * because that is the one with somebody waiting at the other end.
 */
export async function pendingApprovalCount(): Promise<number> {
  if (!supabaseConfigured) return 0;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('pending_student_count', {});
  if (error) return 0;
  return typeof data === 'number' ? data : 0;
}

/**
 * Tell the office somebody has registered.
 *
 * Called from the sign-up action, and deliberately never allowed to fail it: a
 * student who has just created an account must not see an error because the
 * school's mail server was slow. Every path here swallows and reports.
 */
export async function notifyOfficeOfRegistration(input: {
  fullName: string;
  email: string;
  userId: string;
}): Promise<void> {
  try {
    await sendMail(
      newRegistration({
        to: officeInbox(institut.email),
        fullName: input.fullName,
        email: input.email,
        reviewUrl: `${siteUrl()}/admin/students/${input.userId}`,
      }),
    );
  } catch (cause) {
    reportError('registrations.notify', cause, {
      note: 'the account was created; only the alert to the office failed',
    });
  }
}


