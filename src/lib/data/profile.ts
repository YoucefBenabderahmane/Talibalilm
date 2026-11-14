import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { currentViewer } from '@/lib/auth/guards';
import { signDownload } from '@/lib/storage/r2';

/**
 * The student's own enrolment details.
 *
 * Read through the ordinary client: `profiles_select_own` lets a signed-in
 * student see exactly their row, and the email comes from the auth user
 * because that is where it lives. Nothing here is cached — it is one person's
 * record, not the catalogue.
 */

export interface StudentProfile {
  email: string | null;
  civility: string | null;
  firstName: string;
  lastName: string;
  phone: string | null;
  phoneLandline: string | null;
  /** `YYYY-MM-DD`, as Postgres returns a date. */
  birthDate: string | null;
  address: string;
  postalCode: string;
  city: string;
  department: string;
  /** R2 object key of the photo, never a URL. */
  avatarKey: string | null;
}

/**
 * A URL for one stored photo, minted when a page needs it.
 *
 * The bucket is private, so this is a short-lived signature — the same rule
 * slides and lesson videos follow. The key never leaves the server; only the
 * signed link does, and it stops working within the hour.
 */
export async function avatarUrl(key: string | null): Promise<string | null> {
  if (!key) return null;
  return signDownload(key, 3600);
}

export async function getStudentProfile(): Promise<StudentProfile | null> {
  if (!supabaseConfigured) return null;

  // Who is asking comes from the request's one identity lookup, not from a
  // second `getUser()` round trip of this function's own.
  const viewer = await currentViewer();
  if (!viewer) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from('profiles')
    .select(
      'civility, first_name, last_name, phone, phone_landline, birth_date, address, postal_code, city, department, avatar_key',
    )
    .eq('id', viewer.id)
    .maybeSingle();

  if (!data) return null;

  return {
    email: viewer.email,
    civility: data.civility,
    firstName: data.first_name,
    lastName: data.last_name,
    phone: data.phone,
    phoneLandline: data.phone_landline,
    birthDate: data.birth_date,
    address: data.address,
    postalCode: data.postal_code,
    city: data.city,
    department: data.department,
    avatarKey: data.avatar_key,
  };
}

/**
 * May this account open an order?
 *
 * Asked of the database rather than read from a flag here: `is_approved()` is
 * the same function the checkout actions call, so the page and the gate cannot
 * disagree. Staff are approved by their role and are never in the queue.
 */
export async function isApproved(): Promise<boolean> {
  if (!supabaseConfigured) return false;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('is_approved');
  if (error) return false;
  return data === true;
}

/**
 * Is the enrolment complete enough to take a payment?
 *
 * The same fields the form marks required, checked on the server so a
 * hand-posted action cannot pay on a half-filled profile. The email is not
 * checked: it belongs to the account, not to this form.
 */
export function profileComplete(profile: StudentProfile | null): boolean {
  if (!profile) return false;
  return (
    profile.civility !== null &&
    profile.firstName.trim() !== '' &&
    profile.lastName.trim() !== '' &&
    (profile.phone ?? '').trim() !== '' &&
    profile.birthDate !== null &&
    profile.address.trim() !== '' &&
    profile.postalCode.trim() !== '' &&
    profile.city.trim() !== '' &&
    profile.department.trim() !== ''
  );
}
