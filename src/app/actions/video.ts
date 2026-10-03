'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { requireStaff } from '@/lib/auth/guards';
import { checkVideo, MAX_VIDEO_BYTES } from '@/lib/media/video';
import { isVideoKeyFor, slideName, videoKey } from '@/lib/storage/key';
import { deleteObject, r2Configured, readObjectHead, signUpload } from '@/lib/storage/r2';
import { reportError } from '@/lib/observability/report';
import type { AdminState } from '@/app/actions/admin';
import { errorDetail } from '@/lib/supabase/error-detail';

/**
 * A lesson video stored in our own bucket.
 *
 * The same two-step shape as the slide uploader, for the same reason: a
 * presigned PUT cannot cap or inspect what the browser actually sends, so the
 * file is judged AFTER it exists, by reading its first bytes and its true
 * length back out of R2. An object with no row is invisible to every read path
 * in the app, so a rejected upload leaves nothing reachable behind even if the
 * cleanup delete also fails.
 *
 * Going direct to Cloudflare is not an optimisation here, it is the only
 * option: a two-gigabyte file cannot pass through a Vercel function at all.
 *
 * This does not replace the YouTube/Drive link. A long recording belongs on a
 * platform built to stream it for free; this is for the times the school has a
 * file and wants it behind the paywall without a third party involved.
 */

const OK: AdminState = { ok: true };

async function staffClient() {
  if (!supabaseConfigured) throw new Error('unavailable');
  await requireStaff();
  return createClient();
}

export interface VideoTicket extends AdminState {
  url?: string;
  key?: string;
}

const startSchema = z.object({
  lessonId: z.string().uuid(),
  contentType: z.enum(['video/mp4', 'video/webm']),
  // What the browser SAYS the file weighs. Refusing an obviously oversized file
  // here saves an hour of uploading before the rejection — but it is a
  // courtesy, not the rule. The rule is the measured size in `finish`.
  size: z.number().int().positive().max(MAX_VIDEO_BYTES),
});

export async function startLessonVideoUpload(input: {
  lessonId: string;
  contentType: string;
  size: number;
}): Promise<VideoTicket> {
  if (!r2Configured) return { ok: false, error: 'storageUnavailable' };

  const parsed = startSchema.safeParse(input);
  if (!parsed.success) {
    const tooBig = parsed.error.issues.some((i) => i.path[0] === 'size');
    return { ok: false, error: tooBig ? 'videoTooLarge' : 'invalid' };
  }

  const supabase = await staffClient();

  // Through the ordinary client, so the policy decides whether this lesson is
  // visible rather than a condition written here.
  const { data: lesson, error } = await supabase
    .from('lessons')
    .select('id')
    .eq('id', parsed.data.lessonId)
    .maybeSingle();
  if (error) {
    reportError('video.lookup', error, { lessonId: parsed.data.lessonId });
    return { ok: false, error: 'saveFailed', detail: errorDetail(error) };
  }
  if (!lesson) return { ok: false, error: 'invalid' };

  const extension = parsed.data.contentType === 'video/webm' ? 'webm' : 'mp4';
  const key = videoKey(parsed.data.lessonId, extension, slideName());

  // Twenty minutes: a 2 GB file on a domestic uplink takes longer than the five
  // the slide uploader allows, and a signature that expires mid-upload fails
  // with a 403 that names nothing.
  const url = await signUpload(key, parsed.data.contentType, 20 * 60);
  if (!url) return { ok: false, error: 'storageUnavailable' };

  return { ok: true, url, key };
}

const finishSchema = z.object({
  lessonId: z.string().uuid(),
  key: z.string().max(300),
});

export async function finishLessonVideoUpload(input: {
  lessonId: string;
  key: string;
}): Promise<AdminState> {
  if (!r2Configured) return { ok: false, error: 'storageUnavailable' };

  const parsed = finishSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid' };
  const { lessonId, key } = parsed.data;

  // Is this a key we would have issued for THIS lesson? A caller naming another
  // lesson's object stops here, before R2 is touched.
  if (!isVideoKeyFor(key, lessonId)) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();

  const object = await readObjectHead(key, 16);
  if (!object) return { ok: false, error: 'uploadFailed' };

  const check = checkVideo(object.head, object.size);
  if (!check.ok) {
    await deleteObject(key);
    return { ok: false, error: check.error };
  }

  // Replacing an existing upload: the old object is orphaned the moment the row
  // points elsewhere, so it is removed first. Read before write, deliberately —
  // the alternative leaves a file nobody can ever find and nobody stops paying
  // for.
  const { data: existing } = await supabase
    .from('lesson_content')
    .select('video_provider, video_id')
    .eq('lesson_id', lessonId)
    .maybeSingle();
  if (existing?.video_provider === 'r2' && existing.video_id && existing.video_id !== key) {
    await deleteObject(existing.video_id);
  }

  // Upsert, not update: a lesson whose content row is missing (a seeded or
  // pre-`addLesson` one) used to update zero rows and answer `{ ok: true }` —
  // the upload looked saved and no row pointed at the object. Only the video
  // columns are written, so an existing row keeps its text.
  const { error } = await supabase
    .from('lesson_content')
    .upsert(
      {
        lesson_id: lessonId,
        video_provider: 'r2',
        video_id: key,
        video_bytes: object.size,
        video_uploaded_at: new Date().toISOString(),
      },
      { onConflict: 'lesson_id' },
    );

  if (error) {
    reportError('video.save', error, { lessonId });
    await deleteObject(key);
    return { ok: false, error: 'saveFailed', detail: errorDetail(error) };
  }

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  return OK;
}

/**
 * Take the video down.
 *
 * Available whenever one exists — the school asked to be able to remove a
 * recording at any time, and storage is billed monthly, so "remove" has to mean
 * the object is gone from the bucket rather than merely unlinked.
 *
 * The row is cleared even when the delete fails. An object we cannot delete is
 * a cost; a row pointing at an object that may or may not exist is a broken
 * player for every student. The failure is reported either way.
 */
export async function removeLessonVideo(input: { lessonId: string }): Promise<AdminState> {
  const parsed = z.object({ lessonId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid' };
  const { lessonId } = parsed.data;

  const supabase = await staffClient();

  const { data: row } = await supabase
    .from('lesson_content')
    .select('video_provider, video_id')
    .eq('lesson_id', lessonId)
    .maybeSingle();

  if (row?.video_provider === 'r2' && row.video_id) {
    await deleteObject(row.video_id);
  }

  const { error } = await supabase
    .from('lesson_content')
    .update({
      video_provider: 'none',
      video_id: null,
      video_bytes: 0,
      video_uploaded_at: null,
      video_expires_at: null,
    })
    .eq('lesson_id', lessonId);

  if (error) {
    reportError('video.remove', error, { lessonId });
    return { ok: false, error: 'saveFailed', detail: errorDetail(error) };
  }

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  return OK;
}

/**
 * How long to keep it.
 *
 * Null means indefinitely. Anything else is a date the sweep will act on, which
 * is what stops a year of recordings quietly becoming a bill nobody chose.
 */
export async function setVideoRetention(input: {
  lessonId: string;
  months: number | null;
}): Promise<AdminState> {
  const parsed = z
    .object({ lessonId: z.string().uuid(), months: z.number().int().min(1).max(60).nullable() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const expires =
    parsed.data.months === null
      ? null
      : new Date(Date.now() + parsed.data.months * 30 * 24 * 60 * 60 * 1000).toISOString();

  const supabase = await staffClient();
  const { error } = await supabase
    .from('lesson_content')
    .update({ video_expires_at: expires })
    .eq('lesson_id', parsed.data.lessonId);

  if (error) {
    reportError('video.retention', error, { lessonId: parsed.data.lessonId });
    return { ok: false, error: 'saveFailed', detail: errorDetail(error) };
  }

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  return OK;
}
