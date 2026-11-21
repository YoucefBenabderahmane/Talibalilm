'use server';

import { revalidatePath } from 'next/cache';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { redirect } from '@/i18n/navigation';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { getCourse } from '@/lib/data/courses';
import { courseLessons } from '@/lib/content/types';
import { neighbours } from '@/lib/learn/path';
import { reportError } from '@/lib/observability/report';

const markSchema = z.object({
  lessonId: z.string().uuid(),
  completed: z.boolean(),
});

export interface ProgressState {
  ok: boolean;
  error?: string;
}

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * Write one lesson's finished state, as the signed-in student.
 *
 * No access check in here on purpose. The RLS policy on `lesson_progress`
 * requires `has_lesson_access()` to insert, so a write for a lesson the
 * student does not hold is refused by the database. Re-checking in application
 * code would imply the database check is optional, which is the habit this
 * rebuild is meant to break.
 */
async function writeCompletion(
  supabase: Client,
  userId: string,
  lessonId: string,
  completed: boolean,
): Promise<boolean> {
  const { error } = await supabase.from('lesson_progress').upsert(
    {
      user_id: userId,
      lesson_id: lessonId,
      status: completed ? 'completed' : 'in_progress',
      completed_at: completed ? new Date().toISOString() : null,
    },
    { onConflict: 'user_id,lesson_id' },
  );
  if (error) {
    reportError('progress.write', error, { lessonId, completed });
    return false;
  }
  return true;
}

/** Mark a lesson complete, or undo it. */
export async function setLessonComplete(
  _prev: ProgressState,
  formData: FormData,
): Promise<ProgressState> {
  if (!supabaseConfigured) return { ok: false, error: 'unavailable' };

  const parsed = markSchema.safeParse({
    lessonId: formData.get('lessonId'),
    completed: formData.get('completed') === 'true',
  });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauthenticated' };

  if (!(await writeCompletion(supabase, user.id, parsed.data.lessonId, parsed.data.completed))) {
    return { ok: false, error: 'refused' };
  }

  revalidatePath('/dashboard', 'layout');
  return { ok: true };
}

const continueSchema = z.object({
  lessonId: z.string().uuid(),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
});

/**
 * "Terminer et continuer": finish this lesson and open the next one.
 *
 * One act for the student instead of two unrelated clicks. The form posts the
 * lesson and the module's slug and nothing else — where "next" is, is worked
 * out here from the module's own order, never taken from the browser, so a
 * crafted form cannot be used to send somebody anywhere but a lesson of the
 * module they are in. After the last lesson the student lands on the module's
 * home, which is where the finished state is shown.
 *
 * A refused write returns instead of redirecting: moving on while silently
 * dropping the progress would show the student a bar that never fills.
 */
export async function completeAndContinue(
  _prev: ProgressState,
  formData: FormData,
): Promise<ProgressState> {
  if (!supabaseConfigured) return { ok: false, error: 'unavailable' };

  const parsed = continueSchema.safeParse({
    lessonId: formData.get('lessonId'),
    slug: formData.get('slug'),
  });
  if (!parsed.success) return { ok: false, error: 'invalid' };
  const { lessonId, slug } = parsed.data;

  const course = await getCourse(slug);
  if (!course) return { ok: false, error: 'invalid' };
  const { index, next } = neighbours(courseLessons(course), lessonId);
  if (index === -1) return { ok: false, error: 'invalid' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauthenticated' };

  if (!(await writeCompletion(supabase, user.id, lessonId, true))) {
    return { ok: false, error: 'refused' };
  }

  revalidatePath('/dashboard', 'layout');

  const href = next
    ? `/dashboard/courses/${course.slug}/lessons/${next.id}`
    : `/dashboard/courses/${course.slug}`;
  return redirect({ href, locale: await getLocale() });
}

/**
 * Finish a lesson because its video played to the end.
 *
 * Called by the player, not by a form: the student watched the recording, so
 * the lesson is done without being asked to say so. It never un-finishes
 * anything and it does not navigate — the page offers the next lesson, and the
 * student decides when to go.
 */
export async function completeLesson(lessonId: string): Promise<ProgressState> {
  if (!supabaseConfigured) return { ok: false, error: 'unavailable' };
  if (!z.string().uuid().safeParse(lessonId).success) return { ok: false, error: 'invalid' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauthenticated' };

  if (!(await writeCompletion(supabase, user.id, lessonId, true))) {
    return { ok: false, error: 'refused' };
  }

  revalidatePath('/dashboard', 'layout');
  return { ok: true };
}

const positionSchema = z.object({
  lessonId: z.string().uuid(),
  // The column's own bounds: a day at most, never negative.
  seconds: z.number().int().min(0).max(86_400),
});

/**
 * Remember where the student is in a recording.
 *
 * `seconds_watched` has been on the table since the first migration and
 * nothing wrote it, so a two-hour class always reopened at 0:00. This is
 * best-effort by design: it is called on a timer and when the tab is hidden,
 * it returns nothing, and a failure is reported and otherwise ignored — losing
 * a position must never interrupt the lesson.
 *
 * An update first, an insert only when there is no row: the position must not
 * touch `status`, so a finished lesson watched again stays finished. A new row
 * starts `in_progress`. RLS decides both writes, as for completion.
 */
export async function saveLessonPosition(lessonId: string, seconds: number): Promise<void> {
  if (!supabaseConfigured) return;

  const parsed = positionSchema.safeParse({
    lessonId,
    seconds: Math.floor(seconds),
  });
  if (!parsed.success) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: updated, error: updateError } = await supabase
    .from('lesson_progress')
    .update({ seconds_watched: parsed.data.seconds })
    .eq('user_id', user.id)
    .eq('lesson_id', parsed.data.lessonId)
    .select('id');
  if (updateError) {
    reportError('progress.position', updateError, {
      lessonId: parsed.data.lessonId,
    });
    return;
  }
  if ((updated ?? []).length > 0) return;

  const { error: insertError } = await supabase.from('lesson_progress').insert({
    user_id: user.id,
    lesson_id: parsed.data.lessonId,
    status: 'in_progress',
    seconds_watched: parsed.data.seconds,
  });
  // 23505: another tab created the row between the two statements. The next
  // tick updates it; nothing is lost that matters.
  if (insertError && insertError.code !== '23505') {
    reportError('progress.position', insertError, {
      lessonId: parsed.data.lessonId,
    });
  }
}
