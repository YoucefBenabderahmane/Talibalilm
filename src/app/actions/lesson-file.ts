'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { requireStaff } from '@/lib/auth/guards';
import { checkDocument, MAX_DOCUMENT_BYTES } from '@/lib/media/document';
import { documentKey, isDocumentKeyFor, safeFilename, slideName } from '@/lib/storage/key';
import { deleteObject, r2Configured, readObjectHead, signUpload } from '@/lib/storage/r2';
import { documentRows, readDocuments } from '@/lib/content/lesson-files';
import { reportError } from '@/lib/observability/report';
import type { AdminState } from '@/app/actions/admin';
import { errorDetail } from '@/lib/supabase/error-detail';

/**
 * A lesson's support documents, stored in our own bucket.
 *
 * Same two-step shape as the video uploader, for the same reason: a presigned
 * PUT cannot cap or inspect what the browser actually sends, so the file is
 * judged AFTER it exists, by reading its first bytes and its true length back
 * out of R2. An object with no row is invisible to every read path in the app,
 * so a rejected upload leaves nothing reachable behind even if the cleanup
 * delete also fails.
 *
 * The documents live in `class_lesson_content.attachments`, beside the text and
 * the recording of the same group, so a group that has not been given this
 * lesson yet has none — the row policy is the gate, exactly as for the video.
 * The column already existed; this is the first writer.
 *
 * Several are allowed. The array is written back whole on every change, so the
 * entry order is the display order and removing one never disturbs the rest.
 */

const OK: AdminState = { ok: true };

async function staffClient() {
  if (!supabaseConfigured) throw new Error('unavailable');
  await requireStaff();
  return createClient();
}

export interface DocumentTicket extends AdminState {
  url?: string;
  key?: string;
}

const startSchema = z.object({
  lessonId: z.string().uuid(),
  classId: z.string().uuid(),
  contentType: z.literal('application/pdf'),
  // What the browser SAYS the file weighs. Refusing an obviously oversized file
  // here saves an hour of uploading before the rejection — but it is a
  // courtesy, not the rule. The rule is the measured size in `finish`.
  size: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
});

export async function startLessonDocumentUpload(input: {
  lessonId: string;
  classId: string;
  contentType: string;
  size: number;
}): Promise<DocumentTicket> {
  if (!r2Configured) return { ok: false, error: 'storageUnavailable' };

  const parsed = startSchema.safeParse(input);
  if (!parsed.success) {
    const tooBig = parsed.error.issues.some((i) => i.path[0] === 'size');
    return { ok: false, error: tooBig ? 'documentTooLarge' : 'invalid' };
  }

  const supabase = await staffClient();

  // Through the ordinary client, so the policy decides whether this lesson is
  // visible rather than a condition written here. The class must belong to the
  // lesson's own module: a hand-posted pair must not file a Fiqh document on a
  // Hadith group.
  const [{ data: lesson, error }, { data: klass }] = await Promise.all([
    supabase
      .from('lessons')
      .select('id, modules ( course_id )')
      .eq('id', parsed.data.lessonId)
      .maybeSingle(),
    supabase
      .from('classes')
      .select('id, course_id')
      .eq('id', parsed.data.classId)
      .maybeSingle(),
  ]);
  if (error) {
    reportError('lessonFile.lookup', error, { lessonId: parsed.data.lessonId });
    return { ok: false, error: 'saveFailed', detail: errorDetail(error) };
  }
  const lessonCourse = (lesson?.modules as { course_id: string } | null)?.course_id ?? null;
  if (!lesson || !klass || lessonCourse !== klass.course_id) return { ok: false, error: 'invalid' };

  const key = documentKey(parsed.data.lessonId, slideName());

  // An hour: a one-gigabyte file on a domestic uplink takes longer than the
  // video's twenty minutes pretend it does, and a signature that expires
  // mid-upload fails with a 403 that names nothing.
  const url = await signUpload(key, 'application/pdf', 60 * 60);
  if (!url) return { ok: false, error: 'storageUnavailable' };

  return { ok: true, url, key };
}

const finishSchema = z.object({
  lessonId: z.string().uuid(),
  classId: z.string().uuid(),
  key: z.string().max(300),
  filename: z.string().max(300).default(''),
});

export async function finishLessonDocumentUpload(input: {
  lessonId: string;
  classId: string;
  key: string;
  filename: string;
}): Promise<AdminState> {
  if (!r2Configured) return { ok: false, error: 'storageUnavailable' };

  const parsed = finishSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid' };
  const { lessonId, classId, key } = parsed.data;

  // Is this a key we would have issued for THIS lesson? A caller naming another
  // lesson's object stops here, before R2 is touched.
  if (!isDocumentKeyFor(key, lessonId)) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();

  const object = await readObjectHead(key, 16);
  if (!object.ok) return { ok: false, error: 'uploadFailed', detail: object.detail };

  const check = checkDocument(object.head, object.size);
  if (!check.ok) {
    after(async () => {
      await deleteObject(key);
    });
    return { ok: false, error: check.error };
  }

  // Read the row first: the attachments array is written back whole, and a
  // blind upsert of one entry would delete whatever else was in it.
  const { data: current, error: readError } = await supabase
    .from('class_lesson_content')
    .select('attachments')
    .eq('lesson_id', lessonId)
    .eq('class_id', classId)
    .maybeSingle();
  if (readError) {
    reportError('lessonFile.read', readError, { lessonId, classId });
    after(async () => {
      await deleteObject(key);
    });
    return { ok: false, error: 'saveFailed', detail: errorDetail(readError) };
  }

  const documents = [
    ...readDocuments(current?.attachments),
    {
      key,
      filename: safeFilename(parsed.data.filename),
      bytes: object.size,
      uploadedAt: new Date().toISOString(),
    },
  ];

  // Upsert, not update: a class whose content row is missing used to update
  // zero rows and answer `{ ok: true }` — the upload looked saved and no row
  // pointed at the object. Only `attachments` is written, so an existing row
  // keeps its text and its recording.
  const { error } = await supabase.from('class_lesson_content').upsert(
    {
      lesson_id: lessonId,
      class_id: classId,
      attachments: documentRows(documents),
    },
    { onConflict: 'class_id,lesson_id' },
  );

  if (error) {
    reportError('lessonFile.save', error, { lessonId, classId });
    after(async () => {
      await deleteObject(key);
    });
    return { ok: false, error: 'saveFailed', detail: errorDetail(error) };
  }

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  return OK;
}

const removeSchema = z.object({
  lessonId: z.string().uuid(),
  classId: z.string().uuid(),
  key: z.string().max(300),
});

/**
 * Take one document down.
 *
 * The row stops pointing at it first; the object is deleted after the response,
 * so a bucket that is slow to answer never holds the button. The rest of the
 * array is untouched.
 */
export async function removeLessonDocument(input: {
  lessonId: string;
  classId: string;
  key: string;
}): Promise<AdminState> {
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid' };
  const { lessonId, classId, key } = parsed.data;
  if (!isDocumentKeyFor(key, lessonId)) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();

  const { data: current, error: readError } = await supabase
    .from('class_lesson_content')
    .select('attachments')
    .eq('lesson_id', lessonId)
    .eq('class_id', classId)
    .maybeSingle();
  if (readError) return { ok: false, error: 'saveFailed', detail: errorDetail(readError) };
  // No row means no attachment to remove — the answer is the same either way.
  if (!current) return OK;

  const remaining = readDocuments(current.attachments).filter((document) => document.key !== key);
  const { error } = await supabase
    .from('class_lesson_content')
    .update({ attachments: documentRows(remaining) })
    .eq('lesson_id', lessonId)
    .eq('class_id', classId);
  if (error) {
    reportError('lessonFile.remove', error, { lessonId, classId });
    return { ok: false, error: 'saveFailed', detail: errorDetail(error) };
  }

  after(async () => {
    await deleteObject(key);
  });

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  return OK;
}
