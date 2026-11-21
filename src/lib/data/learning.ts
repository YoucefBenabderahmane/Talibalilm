import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { readDocuments, type LessonDocument } from '@/lib/content/lesson-files';
import { reportError } from '@/lib/observability/report';
import type { EntitlementRow, LessonContentRow, ProgressRow } from '@/lib/supabase/database.types';

/**
 * Member-only reads.
 *
 * Everything here goes through the request-scoped anon client, so RLS decides.
 * That is deliberate: a non-member calling `getLessonContent` gets `null`
 * because the database returned nothing, not because a branch above it chose
 * to hide something. The service-role client is never used on this path — if
 * it were, a bug in a caller would become a content leak.
 */

export interface LessonContent {
  content: string;
  videoProvider: LessonContentRow['video_provider'];
  /** An opaque id, never a playable URL. Exchanged for a signed URL in Phase 5. */
  videoId: string | null;
  /** The group's support documents, keys only — signed per reader, per request. */
  documents: LessonDocument[];
}

/** Null when the caller may not read it — which is the same answer as "absent". */
export async function getLessonContent(lessonId: string): Promise<LessonContent | null> {
  if (!supabaseConfigured) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from('lesson_content')
    .select('content, video_provider, video_id, attachments')
    .eq('lesson_id', lessonId)
    .maybeSingle();

  if (!data) return null;
  return {
    content: data.content,
    videoProvider: data.video_provider,
    videoId: data.video_id,
    documents: readDocuments(data.attachments),
  };
}

/**
 * The content of one lesson as taught to one group.
 *
 * Null means either "this class has not been given this lesson yet" or "the
 * caller may not read it" — the policy answers both, so the page never has to
 * guess which. It never falls back to the shared row: mixing the groups is the
 * thing this table exists to prevent.
 */
export async function getClassLessonContent(
  lessonId: string,
  classId: string,
): Promise<LessonContent | null> {
  if (!supabaseConfigured) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from('class_lesson_content')
    .select('content, video_provider, video_id, attachments')
    .eq('lesson_id', lessonId)
    .eq('class_id', classId)
    .maybeSingle();

  if (!data) return null;
  return {
    content: data.content,
    videoProvider: data.video_provider,
    videoId: data.video_id,
    documents: readDocuments(data.attachments),
  };
}

/** The group this student is in for one course, or null. RLS returns only theirs. */
export async function getViewerClassId(courseId: string, userId: string): Promise<string | null> {
  if (!supabaseConfigured) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from('class_members')
    .select('class_id')
    .eq('course_id', courseId)
    .eq('user_id', userId)
    .maybeSingle();

  return data?.class_id ?? null;
}

/**
 * The published modules this student holds.
 *
 * Asked of the database, by the same `has_course_access` the lesson policies
 * call (`my_course_ids`), so "Mes formations" lists exactly what the paywall
 * would open — a module bought outright, a year of a cursus, on the clock,
 * with nothing overdue — without a second copy of that rule living here.
 *
 * Null means "could not be asked": the function is missing on a project that
 * has not run its migration, or the database did not answer. The caller falls
 * back to the courses the student has opened rather than showing an empty
 * page, which is what a wrongly empty set would do.
 */
export async function getMyCourseIds(): Promise<Set<string> | null> {
  if (!supabaseConfigured) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('my_course_ids');
  if (error) {
    reportError('learning.myCourses', error);
    return null;
  }
  return new Set(data ?? []);
}

/**
 * Which of these lessons have content for the caller's own group.
 *
 * Ids only, and no class id in the question: the policy on
 * `class_lesson_content` returns a student the rows of the group they sit in
 * and nothing of another, so the filter is the database's — the same posture
 * as every other member read here. Not asking for the class also means this
 * can go out together with the other reads of a page instead of waiting for
 * the one that finds the group.
 *
 * It is what lets the syllabus tell a lesson that can be opened now from one
 * the school has not published for this group yet. Meaningless for staff,
 * whom the policy shows every group's rows: the pages do not ask it for them.
 */
export async function listGroupLessonIds(lessonIds: string[]): Promise<Set<string>> {
  if (!supabaseConfigured || lessonIds.length === 0) return new Set();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('class_lesson_content')
    .select('lesson_id')
    .in('lesson_id', lessonIds);
  if (error) {
    reportError('learning.groupLessons', error);
    return new Set();
  }
  return new Set((data ?? []).map((row) => row.lesson_id));
}

/**
 * Everything the reader currently holds, soonest expiry first.
 *
 * RLS returns only their own rows, so there is no `user_id` filter here —
 * adding one would suggest the filtering is this function's job when it is
 * the database's.
 */
export async function getEntitlements(): Promise<EntitlementRow[]> {
  if (!supabaseConfigured) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from('entitlements')
    .select('*')
    .eq('status', 'active')
    .order('expires_at', { ascending: true });

  // Trust the clock rather than the stored status: the nightly sweep may not
  // have run, and the RLS gate makes the same judgement.
  const now = Date.now();
  return (data ?? []).filter((row) => new Date(row.expires_at).getTime() > now);
}

/**
 * Whether the reader may open a specific course.
 *
 * Asked of the database rather than worked out here. `has_course_access` is
 * the same function the RLS policy calls, so the page and the gate can never
 * disagree about who is allowed in — which is exactly the drift that made the
 * old plugin leak.
 */
export async function hasCourseAccess(courseId: string): Promise<boolean> {
  if (!supabaseConfigured) return false;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('has_course_access', {
    cid: courseId,
  });
  if (error) return false;
  return data === true;
}

/**
 * Whether the reader holds anything at all.
 *
 * Only for choosing between "subscribe" and "renew" in the interface. Never a
 * gate — a gate is always about one specific course.
 */
export async function hasAnyEntitlement(): Promise<boolean> {
  return (await getEntitlements()).length > 0;
}

/** Days left on the entitlement that runs longest, or null when there are none. */
export function daysRemaining(entitlements: EntitlementRow[]): number | null {
  if (entitlements.length === 0) return null;
  const latest = Math.max(...entitlements.map((e) => new Date(e.expires_at).getTime()));
  return Math.max(0, Math.ceil((latest - Date.now()) / 86_400_000));
}

export async function getCourseProgress(lessonIds: string[]): Promise<Map<string, ProgressRow>> {
  const byLesson = new Map<string, ProgressRow>();
  if (!supabaseConfigured || lessonIds.length === 0) return byLesson;

  const supabase = await createClient();
  const { data } = await supabase.from('lesson_progress').select('*').in('lesson_id', lessonIds);

  for (const row of data ?? []) byLesson.set(row.lesson_id, row);
  return byLesson;
}

/**
 * Record that the student opened this course.
 *
 * Enrolment is a bookmark, not a gate: what decides access is the entitlement,
 * so this is created on first access rather than by an explicit act, and a
 * failure here must never block the lesson from rendering.
 */
export async function touchEnrollment(courseId: string, userId: string): Promise<void> {
  if (!supabaseConfigured) return;

  const supabase = await createClient();
  const { error } = await supabase.from('enrollments').upsert(
    {
      user_id: userId,
      course_id: courseId,
      last_accessed_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,course_id' },
  );

  if (error) console.error('[enrollments] touch failed:', error.message);
}
