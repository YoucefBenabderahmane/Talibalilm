import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { reportError } from '@/lib/observability/report';

/**
 * The groups a module's live sessions are taught to.
 *
 * A class is a named group inside a module — "Classe A", "Samedi 9h" — and a
 * student belongs to one per module. Every read goes through the ordinary
 * client, so the policies decide: a buyer sees the groups of a module they
 * hold, staff see all of them, and nobody sees another module's.
 */

export interface ClassMember {
  id: string;
  name: string;
}

export interface ClassWithMembers {
  id: string;
  name: string;
  schedule: string;
  position: number;
  members: ClassMember[];
}

export interface StudentClass {
  id: string;
  name: string;
  schedule: string;
}

/**
 * The classes of one module, with their rosters — the admin screen's read.
 *
 * Two queries plus one for names, rather than an embedded join: `class_members`
 * points at `auth.users`, which PostgREST cannot embed through `profiles`, and
 * a read that silently returns nothing is how a roster looks empty when it is
 * not. Staff-only by policy; a student calling this would see their own row.
 */
export async function listClassesWithMembers(courseId: string): Promise<ClassWithMembers[]> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();

  const [{ data: classes, error }, { data: members }] = await Promise.all([
    supabase
      .from('classes')
      .select('id, name, schedule, position')
      .eq('course_id', courseId)
      .order('position')
      .order('name'),
    supabase.from('class_members').select('class_id, user_id').eq('course_id', courseId),
  ]);
  if (error) {
    reportError('classes.list', error, { courseId });
    return [];
  }

  const userIds = [...new Set((members ?? []).map((m) => m.user_id))];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', userIds);
    for (const profile of profiles ?? []) names.set(profile.id, profile.full_name);
  }

  const byClass = new Map<string, ClassMember[]>();
  for (const member of members ?? []) {
    const roster = byClass.get(member.class_id) ?? [];
    roster.push({ id: member.user_id, name: names.get(member.user_id) ?? '' });
    byClass.set(member.class_id, roster);
  }

  return (classes ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    position: row.position,
    members: byClass.get(row.id) ?? [],
  }));
}

/**
 * What a student sees on a module they hold: the groups to choose from, and
 * the one they are in, if any. Their own membership is the only one the policy
 * returns for a non-staff caller.
 */
export async function listClassesForStudent(
  courseId: string,
  userId: string,
): Promise<{ classes: StudentClass[]; myClassId: string | null }> {
  if (!supabaseConfigured) return { classes: [], myClassId: null };
  const supabase = await createClient();

  const [{ data: classes, error }, { data: mine }] = await Promise.all([
    supabase
      .from('classes')
      .select('id, name, schedule')
      .eq('course_id', courseId)
      .order('position')
      .order('name'),
    supabase
      .from('class_members')
      .select('class_id')
      .eq('course_id', courseId)
      .eq('user_id', userId)
      .maybeSingle(),
  ]);
  if (error) {
    reportError('classes.studentList', error, { courseId });
    return { classes: [], myClassId: null };
  }

  return { classes: classes ?? [], myClassId: mine?.class_id ?? null };
}

/** Every class, for the live-session form's picker. Staff read. */
export async function listClasses(): Promise<
  { id: string; courseId: string; name: string; courseTitle: string }[]
> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('classes')
    .select('id, course_id, name, courses ( title )')
    .order('name');
  if (error) {
    reportError('classes.all', error);
    return [];
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    courseId: row.course_id,
    name: row.name,
    courseTitle: (row.courses as { title: string } | null)?.title ?? '',
  }));
}
