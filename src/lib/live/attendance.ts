import type { AttendanceStatus } from '@/lib/supabase/database.types';

export type { AttendanceStatus };

/**
 * Was this student at this class?
 *
 * One rule, in one place, for the student's own page and for the teacher's
 * roll — so the two cannot give different answers about the same class.
 *
 * The record of who came is `live_participants`: a row is written when a
 * student opens the room. So the automatic answer is "present" when such a row
 * exists and "absent" when the class has ended without one. On top of that sits
 * the teacher's correction (`live_attendance_marks`), which wins whenever there
 * is one: the room only knows who opened it online, and a student who followed
 * on site, or whose connection failed, attended as far as the school is
 * concerned.
 *
 * Pure: it takes what the caller has read through RLS and decides nothing
 * about access.
 */

export interface AttendanceSession {
  status: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AttendanceInput {
  session: AttendanceSession;
  /** Whether the student has an attendance row for this class. */
  joined: boolean;
  /** The teacher's correction, when there is one. */
  mark: AttendanceStatus | null;
  /** When the student entered the group this class was taught to. */
  memberSince: string | null;
}

export interface Attendance {
  status: AttendanceStatus;
  /** True when the answer is the teacher's correction, not the automatic one. */
  corrected: boolean;
}

/**
 * A class that took place: it started, and it is over.
 *
 * A class that was cancelled, or scheduled and never opened, was not held —
 * nobody can have been absent from it. `started_at` is what separates a class
 * that ran from one that was merely closed.
 */
export function wasHeld(session: AttendanceSession): boolean {
  return session.status === 'ended' && session.startedAt !== null;
}

/**
 * The answer for one student and one class, or `null` when the class does not
 * count for them.
 *
 * It counts when it was held and the student was already in the group when it
 * began. A student who joined the group afterwards is not marked absent from
 * classes that came before them — unless they attended one anyway, or the
 * teacher wrote a correction, in which case there is something to show.
 */
export function resolveAttendance({
  session,
  joined,
  mark,
  memberSince,
}: AttendanceInput): Attendance | null {
  if (!wasHeld(session)) return null;

  if (mark) return { status: mark, corrected: true };
  if (joined) return { status: 'present', corrected: false };

  // No row and no correction: absent, but only from a class that was theirs.
  const started = Date.parse(session.startedAt ?? '');
  const since = memberSince ? Date.parse(memberSince) : Number.NaN;
  if (Number.isNaN(started) || Number.isNaN(since) || since > started) return null;

  return { status: 'absent', corrected: false };
}

export interface AttendanceSummary {
  /** Classes that count for the student. */
  total: number;
  present: number;
  absent: number;
  excused: number;
}

export function summarizeAttendance(
  entries: readonly (Pick<Attendance, 'status'> | null)[],
): AttendanceSummary {
  const summary: AttendanceSummary = { total: 0, present: 0, absent: 0, excused: 0 };
  for (const entry of entries) {
    if (!entry) continue;
    summary.total += 1;
    summary[entry.status] += 1;
  }
  return summary;
}
