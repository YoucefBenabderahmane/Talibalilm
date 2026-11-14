import { cache } from 'react';
import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import type { UserRole } from '@/lib/supabase/database.types';

export interface Viewer {
  id: string;
  email: string | null;
  fullName: string;
  role: UserRole;
  /**
   * True when the account exists in `auth.users` but has no `profiles` row.
   *
   * It is not the same as being a student, and conflating the two is what this
   * type exists to prevent. It means the signup trigger never ran — almost
   * always because the account was created before the migrations were applied
   * — and the person is stuck as a student no matter what their role should
   * be, with nothing on screen to say so.
   */
  profileMissing: boolean;
}

/**
 * The signed-in user, or null.
 *
 * `getUser()` rather than `getSession()`: the latter trusts the cookie as-is,
 * while this revalidates the JWT against the auth server. Anywhere a decision
 * hangs on identity, that difference is the whole guarantee.
 *
 * Once per request, through React's `cache()`. A page, its layout, the data
 * helpers under it and the student profile all ask who is signed in, and each
 * used to pay the auth round trip and the profile read again — three to four
 * times on a dashboard click. The first caller's answer now serves the rest
 * of that render; the next request asks afresh.
 */
export const currentViewer = cache(async (): Promise<Viewer | null> => {
  if (!supabaseConfigured) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('full_name, role')
    .eq('id', user.id)
    .maybeSingle();

  // A failed read is not "this person is a student". Defaulting to student on
  // error is how an admin ends up bounced off /admin with no explanation
  // anywhere — the failure has to be visible to whoever can act on it.
  if (error) {
    console.error('[auth] could not read the profile for', user.id, '—', error.message);
  }

  return {
    id: user.id,
    email: user.email ?? null,
    fullName: profile?.full_name ?? '',
    role: profile?.role ?? 'student',
    profileMissing: !profile,
  };
});

export async function requireViewer(): Promise<Viewer> {
  const viewer = await currentViewer();
  // Locale-aware: `next/navigation`'s redirect would send an English reader to
  // the French login page.
  if (!viewer) redirect({ href: '/login', locale: await getLocale() });
  return viewer;
}

export function isStaff(viewer: Viewer): boolean {
  return viewer.role === 'instructor' || viewer.role === 'admin';
}

/**
 * Staff-only pages.
 *
 * A convenience, not the control. Every table the admin touches carries an
 * `is_staff()` policy, so a student who somehow reached the page would still
 * be refused by the database on every read and write.
 *
 * Returns the viewer either way — the admin layout renders an explanation for
 * a non-staff visitor rather than bouncing them somewhere with no account of
 * why, which is indistinguishable from the page being broken.
 */
export async function requireStaff(): Promise<Viewer> {
  const viewer = await requireViewer();
  if (!isStaff(viewer)) redirect({ href: '/dashboard', locale: await getLocale() });
  return viewer;
}

/** Admin-only. Payment settings have no RLS policy to fall back on. */
export async function requireAdmin(): Promise<Viewer> {
  const viewer = await requireViewer();
  if (viewer.role !== 'admin') redirect({ href: '/dashboard', locale: await getLocale() });
  return viewer;
}
