'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { requireStaff } from '@/lib/auth/guards';
import { errorDetail } from '@/lib/supabase/error-detail';
import { reportError } from '@/lib/observability/report';
import type { AdminState } from '@/app/actions/admin';

/**
 * Managing the groups a module's live sessions are taught to.
 *
 * Creating, renaming and deleting a class is the office's job and goes through
 * the staff policies on `classes`. Joining one is the student's own act and
 * goes through `class_members_join_own`: they may only place themselves, and
 * only in a module they hold. The office may remove anyone — the delete policy
 * says so — but never has to place anybody.
 */

const OK: AdminState = { ok: true };

async function staffClient() {
  if (!supabaseConfigured) throw new Error('unavailable');
  await requireStaff();
  return createClient();
}

const nameSchema = z.string().trim().min(2).max(120);
const scheduleSchema = z.string().trim().max(200).default('');

export async function createClass(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({
      courseId: z.string().uuid(),
      name: nameSchema,
      schedule: scheduleSchema,
    })
    .safeParse({
      courseId: formData.get('courseId'),
      name: formData.get('name'),
      schedule: formData.get('schedule') ?? '',
    });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { error } = await supabase.from('classes').insert({
    course_id: parsed.data.courseId,
    name: parsed.data.name,
    schedule: parsed.data.schedule,
  });
  // A duplicate name is a `23505` from `unique (course_id, name)`; the admin
  // sees the database's own words under our sentence.
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  return OK;
}

export async function updateClass(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({
      id: z.string().uuid(),
      name: nameSchema,
      schedule: scheduleSchema,
    })
    .safeParse({
      id: formData.get('id'),
      name: formData.get('name'),
      schedule: formData.get('schedule') ?? '',
    });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { error } = await supabase
    .from('classes')
    .update({ name: parsed.data.name, schedule: parsed.data.schedule })
    .eq('id', parsed.data.id);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  return OK;
}

/**
 * Delete a class. Its memberships cascade; a session taught to it does not —
 * the composite foreign key refuses, and the office is told which class still
 * has history rather than silently losing it.
 */
export async function deleteClass(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { error } = await supabase.from('classes').delete().eq('id', id.data);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  return OK;
}

/** The office taking a student out of a class (moving them is join-again). */
export async function removeClassMember(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({ classId: z.string().uuid(), userId: z.string().uuid() })
    .safeParse({ classId: formData.get('classId'), userId: formData.get('userId') });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { error } = await supabase
    .from('class_members')
    .delete()
    .eq('class_id', parsed.data.classId)
    .eq('user_id', parsed.data.userId);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/courses/[id]', 'page');
  return OK;
}

export type ClassChoice = { ok: boolean; error?: 'notAllowed' | 'saveFailed' | 'unavailable' };

/**
 * A student choosing their group.
 *
 * One class per module is a `unique (user_id, course_id)` in the database, so
 * moving is leave-then-join. Both statements are the student's own act, and
 * both are refused by policy if the module is not theirs — a hand-posted class
 * id cannot place anybody anywhere.
 */
export async function joinClass(classId: string): Promise<ClassChoice> {
  if (!supabaseConfigured) return { ok: false, error: 'unavailable' };
  const parsed = z.string().uuid().safeParse(classId);
  if (!parsed.success) return { ok: false, error: 'notAllowed' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'notAllowed' };

  // The class names its course; the select policy makes it invisible unless
  // this student holds that module, which is the check that matters.
  const { data: klass } = await supabase
    .from('classes')
    .select('course_id')
    .eq('id', parsed.data)
    .maybeSingle();
  if (!klass) return { ok: false, error: 'notAllowed' };

  await supabase
    .from('class_members')
    .delete()
    .eq('user_id', user.id)
    .eq('course_id', klass.course_id);

  const { error } = await supabase.from('class_members').insert({
    class_id: parsed.data,
    course_id: klass.course_id,
    user_id: user.id,
  });
  if (error) {
    reportError('classes.join', error, { classId: parsed.data });
    return { ok: false, error: 'saveFailed' };
  }

  revalidatePath('/[locale]/courses/[slug]', 'page');
  revalidatePath('/[locale]/dashboard', 'page');
  return { ok: true };
}

/** Leaving is the same act in reverse, so a wrong click is undone. */
export async function leaveClass(classId: string): Promise<ClassChoice> {
  if (!supabaseConfigured) return { ok: false, error: 'unavailable' };
  const parsed = z.string().uuid().safeParse(classId);
  if (!parsed.success) return { ok: false, error: 'notAllowed' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'notAllowed' };

  const { error } = await supabase
    .from('class_members')
    .delete()
    .eq('class_id', parsed.data)
    .eq('user_id', user.id);
  if (error) {
    reportError('classes.leave', error, { classId: parsed.data });
    return { ok: false, error: 'saveFailed' };
  }

  revalidatePath('/[locale]/courses/[slug]', 'page');
  revalidatePath('/[locale]/dashboard', 'page');
  return { ok: true };
}
