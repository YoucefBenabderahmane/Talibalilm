import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { reportError } from '@/lib/observability/report';
import {
  resolveAttendance,
  summarizeAttendance,
  wasHeld,
  type Attendance,
  type AttendanceStatus,
  type AttendanceSummary,
} from '@/lib/live/attendance';
import type { LiveStatus } from '@/lib/supabase/database.types';

/**
 * Attendance, read for the two people it concerns.
 *
 * Everything here goes through the ordinary client, so the policies decide: a
 * student gets the ended classes of the group they sit in, their own
 * attendance rows and the corrections about them; staff get the whole class.
 * Nothing is computed in the database and nothing is stored — the answer is
 * `resolveAttendance` over those reads, the same function on both screens.
 *
 * The corrections table arrives with its own migration. Until it has been run
 * the read fails, and that is treated as "no corrections" rather than as an
 * error on the page: the automatic answer is still true without them.
 */

export interface PastClass {
  id: string;
  title: string;
  courseId: string;
  courseTitle: string;
  startedAt: string;
  status: AttendanceStatus;
  corrected: boolean;
}

export interface MyAttendance {
  /** Most recent first, at most `limit` of them. */
  classes: PastClass[];
  /** Over every class that counts, not only the ones listed. */
  summary: AttendanceSummary;
}

const NONE: MyAttendance = {
  classes: [],
  summary: { total: 0, present: 0, absent: 0, excused: 0 },
};

/** The classes this student's groups have held, and whether they were there. */
export async function myPastClasses(
  userId: string,
  { courseId, limit = 5 }: { courseId?: string; limit?: number } = {},
): Promise<MyAttendance> {
  if (!supabaseConfigured) return NONE;
  const supabase = await createClient();

  let sessionQuery = supabase
    .from('live_sessions')
    .select('id, course_id, class_id, title, status, started_at, ended_at, courses ( title )')
    .eq('status', 'ended')
    .not('started_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(200);
  if (courseId) sessionQuery = sessionQuery.eq('course_id', courseId);

  const [sessionsResult, membersResult] = await Promise.all([
    sessionQuery,
    // Their own memberships. The filter is not what protects other students'
    // rows — the policy is — but staff are shown everyone's, and this page is
    // about one person.
    supabase.from('class_members').select('class_id, joined_at').eq('user_id', userId),
  ]);
  if (sessionsResult.error) {
    reportError('attendance.sessions', sessionsResult.error);
    return NONE;
  }
  if (membersResult.error) {
    reportError('attendance.memberships', membersResult.error);
    return NONE;
  }

  const memberSince = new Map(
    (membersResult.data ?? []).map((row) => [row.class_id, row.joined_at]),
  );
  // Only the groups they sit in. For a student RLS has already narrowed the
  // sessions to these; for staff, who see every class, it is what keeps a
  // teacher from being shown a roll of classes they taught as if they had
  // attended them.
  const sessions = (
    (sessionsResult.data ?? []) as unknown as {
      id: string;
      course_id: string;
      class_id: string;
      title: string;
      status: LiveStatus;
      started_at: string | null;
      ended_at: string | null;
      courses: { title: string } | null;
    }[]
  ).filter((row) => memberSince.has(row.class_id));
  if (sessions.length === 0) return NONE;

  const ids = sessions.map((row) => row.id);
  const [joinedResult, marksResult] = await Promise.all([
    supabase
      .from('live_participants')
      .select('session_id')
      .eq('user_id', userId)
      .in('session_id', ids),
    supabase
      .from('live_attendance_marks')
      .select('session_id, status')
      .eq('user_id', userId)
      .in('session_id', ids),
  ]);
  if (joinedResult.error) {
    reportError('attendance.participants', joinedResult.error);
    return NONE;
  }
  if (marksResult.error) reportError('attendance.marks', marksResult.error);

  const joined = new Set((joinedResult.data ?? []).map((row) => row.session_id));
  const marks = new Map((marksResult.data ?? []).map((row) => [row.session_id, row.status]));

  const resolved: PastClass[] = [];
  for (const row of sessions) {
    const attendance = resolveAttendance({
      session: { status: row.status, startedAt: row.started_at, endedAt: row.ended_at },
      joined: joined.has(row.id),
      mark: marks.get(row.id) ?? null,
      memberSince: memberSince.get(row.class_id) ?? null,
    });
    if (!attendance || !row.started_at) continue;
    resolved.push({
      id: row.id,
      title: row.title,
      courseId: row.course_id,
      courseTitle: row.courses?.title ?? '',
      startedAt: row.started_at,
      status: attendance.status,
      corrected: attendance.corrected,
    });
  }

  return { classes: resolved.slice(0, limit), summary: summarizeAttendance(resolved) };
}

export interface RollRow {
  userId: string;
  name: string;
  /** When they first opened the room for this class, if they did. */
  joinedAt: string | null;
  /** The teacher's correction, when there is one. */
  mark: AttendanceStatus | null;
  /**
   * The answer for a class that was held. Null while the class is still
   * running, and for a student who entered the group after it and did not
   * attend: the class does not count for them.
   */
  attendance: Attendance | null;
}

export interface SessionRoll {
  rows: RollRow[];
  summary: AttendanceSummary;
  /** False until the class has started and ended: the roll is then provisional. */
  held: boolean;
  /** The database's own words when the corrections could not be read. */
  marksError: unknown;
}

/**
 * The roll of one class: every student of its group, present or not.
 *
 * The log the office already had lists who came. This lists who should have:
 * the group's members, each with the answer for this class. Staff-only by
 * policy — a student asking gets their own row of each table and nothing else.
 */
export async function sessionRoll(session: {
  id: string;
  classId: string;
  status: LiveStatus;
  startedAt: string | null;
  endedAt: string | null;
}): Promise<SessionRoll> {
  const empty: SessionRoll = {
    rows: [],
    summary: { total: 0, present: 0, absent: 0, excused: 0 },
    held: false,
    marksError: null,
  };
  if (!supabaseConfigured) return empty;
  const supabase = await createClient();
  const sessionState = {
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
  const held = wasHeld(sessionState);

  const [membersResult, joinedResult, marksResult] = await Promise.all([
    supabase.from('class_members').select('user_id, joined_at').eq('class_id', session.classId),
    supabase
      .from('live_participants')
      .select('user_id, joined_at')
      .eq('session_id', session.id)
      .order('joined_at', { ascending: true }),
    supabase.from('live_attendance_marks').select('user_id, status').eq('session_id', session.id),
  ]);
  if (membersResult.error) {
    reportError('attendance.roll.members', membersResult.error, { sessionId: session.id });
    return { ...empty, held };
  }
  if (joinedResult.error) {
    reportError('attendance.roll.participants', joinedResult.error, { sessionId: session.id });
  }
  if (marksResult.error) {
    reportError('attendance.roll.marks', marksResult.error, { sessionId: session.id });
  }

  const members = membersResult.data ?? [];
  if (members.length === 0) return { ...empty, held, marksError: marksResult.error };

  // The first time each person opened the room; rows come back oldest first.
  const firstJoin = new Map<string, string>();
  for (const row of joinedResult.data ?? []) {
    if (!firstJoin.has(row.user_id)) firstJoin.set(row.user_id, row.joined_at);
  }
  const marks = new Map((marksResult.data ?? []).map((row) => [row.user_id, row.status]));

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in(
      'id',
      members.map((row) => row.user_id),
    );
  const names = new Map((profiles ?? []).map((row) => [row.id, row.full_name ?? '']));

  const rows: RollRow[] = members
    .map((member) => {
      const mark = marks.get(member.user_id) ?? null;
      const joinedAt = firstJoin.get(member.user_id) ?? null;
      return {
        userId: member.user_id,
        name: names.get(member.user_id) ?? '',
        joinedAt,
        mark,
        attendance: resolveAttendance({
          session: sessionState,
          joined: joinedAt !== null,
          mark,
          memberSince: member.joined_at,
        }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

  return {
    rows,
    summary: summarizeAttendance(rows.map((row) => row.attendance)),
    held,
    marksError: marksResult.error,
  };
}
