import type { Lesson } from '@/lib/content/types';

/**
 * The learning path: where a student is in a module, and where they go next.
 *
 * Pure functions over the ordered lesson list and the student's progress rows,
 * so the dashboard, the module's home and the lesson page cannot disagree
 * about what "finished", "next" or "42 %" mean. They used to: the dashboard
 * counted every progress row, including a lesson the student had un-marked,
 * while the lesson page counted completed ones.
 *
 * Nothing here decides access. A lesson's content is still whatever the
 * RLS-gated read returns; these only describe the route through the module.
 */

/** The one field of a progress row this module reads. */
export interface ProgressLike {
  status: string;
}

export type ProgressMap = ReadonlyMap<string, ProgressLike>;

/** A lesson counts as finished only when its row says so. */
export function isCompleted(row: ProgressLike | null | undefined): boolean {
  return row?.status === 'completed';
}

export interface CourseProgress {
  done: number;
  total: number;
  /** A whole number from 0 to 100. */
  percent: number;
  /** Every lesson finished, in a module that has at least one. */
  complete: boolean;
}

export function courseProgress(lessons: readonly Lesson[], progress: ProgressMap): CourseProgress {
  const total = lessons.length;
  const done = lessons.filter((lesson) => isCompleted(progress.get(lesson.id))).length;
  return {
    done,
    total,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
    complete: total > 0 && done === total,
  };
}

/**
 * The lesson "Reprendre" opens: the first one not finished, in order.
 *
 * A finished module resumes on its first lesson — the student is revising —
 * and a module with no lessons has nowhere to go.
 */
export function resumeLesson(lessons: readonly Lesson[], progress: ProgressMap): Lesson | null {
  if (lessons.length === 0) return null;
  return lessons.find((lesson) => !isCompleted(progress.get(lesson.id))) ?? lessons[0] ?? null;
}

export interface Neighbours {
  /** Zero-based position in the module, or -1 when the lesson is not in it. */
  index: number;
  previous: Lesson | null;
  next: Lesson | null;
}

export function neighbours(lessons: readonly Lesson[], lessonId: string): Neighbours {
  const index = lessons.findIndex((lesson) => lesson.id === lessonId);
  if (index === -1) return { index, previous: null, next: null };
  return {
    index,
    previous: index > 0 ? (lessons[index - 1] ?? null) : null,
    next: index < lessons.length - 1 ? (lessons[index + 1] ?? null) : null,
  };
}

/**
 * How one lesson reads in the syllabus.
 *
 *  - `done`      finished by this student
 *  - `current`   the page being read
 *  - `available` openable now
 *  - `upcoming`  theirs, but the school has not published it for their group yet
 *  - `locked`    not theirs: no access and not a free preview
 */
export type LessonState = 'done' | 'current' | 'available' | 'upcoming' | 'locked';

export interface LessonStateInput {
  lesson: Pick<Lesson, 'id' | 'is_preview'>;
  progress: ProgressMap;
  /** The lesson on screen, when there is one. */
  currentId?: string | null;
  /** Whether the viewer holds the module. */
  hasAccess: boolean;
  /**
   * Lessons that have content for the viewer's group. `null` means "not
   * known" — staff, or a holder with no group yet — and nothing is then
   * reported as upcoming, because saying "à venir" without knowing would be a
   * guess shown as a fact.
   */
  availableIds: ReadonlySet<string> | null;
}

export function lessonState({
  lesson,
  progress,
  currentId,
  hasAccess,
  availableIds,
}: LessonStateInput): LessonState {
  if (lesson.id === currentId) return 'current';
  if (isCompleted(progress.get(lesson.id))) return 'done';
  if (!hasAccess) return lesson.is_preview ? 'available' : 'locked';
  if (availableIds && !availableIds.has(lesson.id)) return 'upcoming';
  return 'available';
}
