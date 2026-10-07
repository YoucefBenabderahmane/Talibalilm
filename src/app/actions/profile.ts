'use server';

import { headers } from 'next/headers';
import { after } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { clientKey, rateLimit } from '@/lib/rate-limit';
import { getStudentProfile, profileComplete } from '@/lib/data/profile';
import { profileDetailsSchema } from '@/lib/validation/profile';
import { reportError } from '@/lib/observability/report';
import { avatarKey, isAvatarKeyFor, objectName } from '@/lib/storage/key';
import { deleteObject, readObjectHead, r2Configured, signUpload } from '@/lib/storage/r2';
import { checkImage, MAX_IMAGE_BYTES } from '@/lib/media/image';

/**
 * Saving the student's enrolment details.
 *
 * The write goes through the ordinary client on purpose: `profiles_update_own`
 * and the column grants are what decide whether it lands, and both are
 * covered by the policy tests. The service role is not used here — this is a
 * student editing their own row, not staff editing someone else's.
 *
 * The full name is kept in step with the first and last names: `full_name` is
 * what the dashboard, the emails and the admin screens already read, and a
 * second name that disagrees with the first is worse than either.
 */
export interface ProfileState {
  ok: boolean;
  /** Already-localised sentence. */
  message?: string;
  fieldErrors?: Record<string, string>;
}

async function resolveFieldErrors(
  issues: { path: PropertyKey[]; message: string }[],
): Promise<Record<string, string>> {
  const t = await getTranslations();
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const field = String(issue.path[0] ?? 'form');
    if (out[field]) continue;
    out[field] = issue.message.includes('.') ? t(issue.message) : issue.message;
  }
  return out;
}

export async function saveCheckoutProfile(
  _previous: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const parsed = profileDetailsSchema.safeParse({
    civility: formData.get('civility'),
    firstName: formData.get('firstName'),
    lastName: formData.get('lastName'),
    phone: formData.get('phone'),
    phoneLandline: formData.get('phoneLandline') ?? '',
    birthDate: formData.get('birthDate'),
    address: formData.get('address'),
    postalCode: formData.get('postalCode'),
    city: formData.get('city'),
    department: formData.get('department'),
  });

  // A Zod failure names the field it came from; a raw dump would be noise.
  if (!parsed.success) return { ok: false, fieldErrors: await resolveFieldErrors(parsed.error.issues) };

  // The write is the student's own row and RLS is the real control, but a
  // form post is still a request: cap how often one caller can make it.
  const { ok } = await rateLimit(clientKey(await headers(), 'profile-save'), {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (!ok) return { ok: false, message: (await getTranslations('checkout'))('rateLimited') };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: (await getTranslations('checkout'))('loginRequired') };

  const details = parsed.data;
  const { error } = await supabase
    .from('profiles')
    .update({
      civility: details.civility,
      first_name: details.firstName,
      last_name: details.lastName,
      full_name: `${details.firstName} ${details.lastName}`.trim(),
      phone: details.phone,
      phone_landline: details.phoneLandline === '' ? null : details.phoneLandline,
      birth_date: details.birthDate,
      address: details.address,
      postal_code: details.postalCode,
      city: details.city,
      department: details.department,
    })
    .eq('id', user.id);

  if (error) {
    // Student-facing: the evidence goes to the log, not to the screen. They
    // cannot act on a Postgres code, and the admin screens are where a cause
    // is meant to be read.
    reportError('profile.save', error, { userId: user.id });
    return { ok: false, message: (await getTranslations('common'))('error') };
  }

  // Read back rather than trust the write. An UPDATE that matches no row
  // reports no error, and a column grant that is missing reports one only for
  // the columns it covers — either way the form would say "saved" over a row
  // that still cannot pay. If the profile is not complete after this, the
  // student is told, not left staring at a disabled button.
  const saved = await getStudentProfile();
  if (!profileComplete(saved)) {
    reportError('profile.save.incomplete', new Error('profile still incomplete after update'), {
      userId: user.id,
    });
    return { ok: false, message: (await getTranslations('checkout'))('profileRequired') };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Profile photo (Cloudflare R2)
// ---------------------------------------------------------------------------

export type AvatarBegin =
  | { ok: true; key: string; uploadUrl: string }
  | { ok: false; error: string };

export type AvatarResult = { ok: true; key: string | null } | { ok: false; error: string };

/** What a browser may PUT to us, mapped to the extension the key carries. */
const AVATAR_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Step one: a signed URL for one photo, under this user's own prefix.
 *
 * The upload goes straight to Cloudflare rather than through a Server Action,
 * for the same reason a slide does. The key is minted HERE, from the user id,
 * so a caller cannot ask us to sign a URL for somebody else's prefix — and the
 * signature pins the content type, so the URL cannot be reused for anything
 * but an image.
 */
export async function beginAvatarUpload(input: {
  contentType: string;
}): Promise<AvatarBegin> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'auth' };

  if (!r2Configured) return { ok: false, error: 'storageUnavailable' };

  const extension = AVATAR_TYPES[input.contentType];
  if (!extension) return { ok: false, error: 'notAnImage' };

  if (!(await avatarThrottle(user.id))) return { ok: false, error: 'rateLimited' };

  const key = avatarKey(user.id, extension, objectName());
  const uploadUrl = await signUpload(key, input.contentType, 300);
  if (!uploadUrl) return { ok: false, error: 'storageUnavailable' };

  return { ok: true, key, uploadUrl };
}

/**
 * Step two: adopt the object the browser just wrote.
 *
 * The bytes decide, not the key and not the declared type. A few bytes are
 * read back server-side and sniffed; an object that is not really a PNG, JPEG
 * or WebP is deleted and never becomes a photo. Only then is the key stored —
 * and the previous object is removed, so replacing a photo does not leave the
 * old one behind in the bucket.
 */
export async function confirmAvatarUpload(key: string): Promise<AvatarResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'auth' };

  // The key came from the browser. It must be one we issued for THIS user, or
  // a crafted one could adopt another student's object.
  if (!isAvatarKeyFor(key, user.id)) return { ok: false, error: 'notAnImage' };

  const head = await readObjectHead(key);
  if (!head.ok) {
    // Student-facing: the raw reason goes to the log, never to the page. The
    // cleanup is a side effect, so a slow bucket does not hold the upload.
    after(async () => {
      await deleteObject(key);
    });
    return { ok: false, error: 'uploadFailed' };
  }

  const check = checkImage(head.head);
  if (!check.ok || head.size > MAX_IMAGE_BYTES) {
    after(async () => {
      await deleteObject(key);
    });
    return { ok: false, error: check.ok ? 'tooLarge' : 'notAnImage' };
  }

  const { data: previous } = await supabase
    .from('profiles')
    .select('avatar_key')
    .eq('id', user.id)
    .maybeSingle();

  const { error } = await supabase
    .from('profiles')
    .update({ avatar_key: key })
    .eq('id', user.id);

  if (error) {
    await deleteObject(key);
    reportError('profile.avatar.save', error, { userId: user.id });
    return { ok: false, error: 'saveFailed' };
  }

  if (previous?.avatar_key && previous.avatar_key !== key) {
    await deleteObject(previous.avatar_key);
  }

  return { ok: true, key };
}

/** Remove the photo, from the row and from the bucket. */
export async function removeAvatar(): Promise<AvatarResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'auth' };

  const { data: current } = await supabase
    .from('profiles')
    .select('avatar_key')
    .eq('id', user.id)
    .maybeSingle();

  const { error } = await supabase
    .from('profiles')
    .update({ avatar_key: null })
    .eq('id', user.id);

  if (error) {
    reportError('profile.avatar.remove', error, { userId: user.id });
    return { ok: false, error: 'saveFailed' };
  }

  if (current?.avatar_key) await deleteObject(current.avatar_key);
  return { ok: true, key: null };
}

async function avatarThrottle(userId: string): Promise<boolean> {
  const { ok } = await rateLimit(`avatar:${userId}`, { limit: 12, windowMs: 15 * 60 * 1000 });
  return ok;
}
