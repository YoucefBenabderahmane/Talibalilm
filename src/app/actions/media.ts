'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { requireStaff } from '@/lib/auth/guards';
import { CATALOGUE_TAG } from '@/lib/data/cache-tags';
import { checkImage } from '@/lib/media/image';
import { galleryToJson, readGallery } from '@/lib/content/presentation';
import { reportError } from '@/lib/observability/report';
import type { AdminState } from '@/app/actions/admin';
import { errorDetail } from '@/lib/supabase/error-detail';

/**
 * Course cover uploads.
 *
 * The file is validated by its BYTES, never its declared content-type, before
 * a single byte reaches storage — see `checkImage`. The upload goes through the
 * ordinary staff session, so the storage policy (`is_staff()`) is the gate, and
 * the public URL is written back to `courses.cover_url` through the same
 * staff-write policy the rest of the editor uses.
 */

const BUCKET = 'course-covers';
const OK: AdminState = { ok: true };

export async function uploadCourseCover(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  if (!supabaseConfigured) return { ok: false, error: 'unavailable' };
  await requireStaff();

  const courseId = z.string().uuid().safeParse(formData.get('courseId'));
  const file = formData.get('file');
  if (!courseId.success) return { ok: false, error: 'invalid' };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'noFile' };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkImage(bytes);
  if (!check.ok) return { ok: false, error: check.error };

  const supabase = await createClient();
  const path = `${courseId.data}/cover-${Date.now()}.${check.extension}`;

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: check.contentType,
    upsert: true,
  });
  if (uploadError) {
    reportError('media.upload', uploadError, { courseId: courseId.data });
    return { ok: false, error: 'uploadFailed', detail: errorDetail(uploadError) };
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);

  const { error: updateError } = await supabase
    .from('courses')
    .update({ cover_url: pub.publicUrl })
    .eq('id', courseId.data);
  if (updateError) {
    reportError('media.setCover', updateError, { courseId: courseId.data });
    return { ok: false, error: 'saveFailed', detail: errorDetail(updateError) };
  }

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  revalidatePath('/[locale]/(site)/courses/[slug]', 'page');
  revalidateTag(CATALOGUE_TAG);
  return OK;
}

export async function removeCourseCover(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  if (!supabaseConfigured) return { ok: false, error: 'unavailable' };
  await requireStaff();

  const courseId = z.string().uuid().safeParse(formData.get('courseId'));
  if (!courseId.success) return { ok: false, error: 'invalid' };

  const supabase = await createClient();
  // Clears the reference; the drawn placeholder takes over again. The object is
  // left in the bucket rather than orphan-hunted here — cheap, and a later
  // sweep can prune covers no course points at.
  const { error } = await supabase
    .from('courses')
    .update({ cover_url: null })
    .eq('id', courseId.data);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  revalidateTag(CATALOGUE_TAG);
  return OK;
}

/**
 * Photographs for the module's Informations carousel.
 *
 * Same gate and the same byte-level check as the cover: the file is validated
 * before it reaches storage, the upload rides the staff session so the storage
 * policy decides, and the URL is appended to `courses.gallery` through the
 * ordinary staff-write policy.
 *
 * Read-modify-write on a JSON array, which is racy in principle. Deliberately
 * accepted: one school, one office, and the worst outcome of two simultaneous
 * uploads is that one photo has to be added again.
 */
const GALLERY_LIMIT = 12;

export async function addGalleryImage(_prev: AdminState, formData: FormData): Promise<AdminState> {
  if (!supabaseConfigured) return { ok: false, error: 'unavailable' };
  await requireStaff();

  const courseId = z.string().uuid().safeParse(formData.get('courseId'));
  const alt = z
    .string()
    .max(200)
    .catch('')
    .parse(formData.get('alt') ?? '');
  const file = formData.get('file');
  if (!courseId.success) return { ok: false, error: 'invalid' };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'noFile' };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkImage(bytes);
  if (!check.ok) return { ok: false, error: check.error };

  const supabase = await createClient();

  const { data: course } = await supabase
    .from('courses')
    .select('gallery')
    .eq('id', courseId.data)
    .maybeSingle();
  const current = readGallery(course?.gallery);
  if (current.length >= GALLERY_LIMIT) return { ok: false, error: 'galleryFull' };

  const path = `${courseId.data}/gallery-${Date.now()}.${check.extension}`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: check.contentType,
    upsert: true,
  });
  if (uploadError) {
    reportError('media.gallery.upload', uploadError, { courseId: courseId.data });
    return { ok: false, error: 'uploadFailed', detail: errorDetail(uploadError) };
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const { error: updateError } = await supabase
    .from('courses')
    .update({ gallery: galleryToJson([...current, { url: pub.publicUrl, alt }]) })
    .eq('id', courseId.data);
  if (updateError) {
    reportError('media.gallery.save', updateError, { courseId: courseId.data });
    return { ok: false, error: 'saveFailed', detail: errorDetail(updateError) };
  }

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  revalidatePath('/[locale]/(site)/courses/[slug]', 'page');
  revalidateTag(CATALOGUE_TAG);
  return OK;
}

export async function removeGalleryImage(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  if (!supabaseConfigured) return { ok: false, error: 'unavailable' };
  await requireStaff();

  const parsed = z
    .object({ courseId: z.string().uuid(), url: z.string().min(1).max(2000) })
    .safeParse({ courseId: formData.get('courseId'), url: formData.get('url') });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await createClient();
  const { data: course } = await supabase
    .from('courses')
    .select('gallery')
    .eq('id', parsed.data.courseId)
    .maybeSingle();

  const kept = readGallery(course?.gallery).filter((image) => image.url !== parsed.data.url);
  const { error } = await supabase
    .from('courses')
    .update({ gallery: galleryToJson(kept) })
    .eq('id', parsed.data.courseId);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  revalidatePath('/[locale]/(site)/courses/[slug]', 'page');
  revalidateTag(CATALOGUE_TAG);
  return OK;
}
