import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';
import { supabaseConfigured } from '@/lib/env';
import { reportError } from '@/lib/observability/report';
import type { LiveStatus } from '@/lib/supabase/database.types';
import { r2Configured, signDownload } from '@/lib/storage/r2';
import type { BoardOp } from '@/lib/live/protocol';

/**
 * Reads for the live classroom.
 *
 * All through the ordinary anon-key client, so the policies decide what comes
 * back. A student's listing is already filtered by `has_course_access()` in the
 * database — there is no `.eq('user_id', …)` here to forget, because the filter
 * is not this layer's job.
 */
export interface LiveSessionView {
  id: string;
  courseId: string;
  courseTitle: string;
  classId: string;
  classTitle: string;
  title: string;
  description: string;
  roomToken: string;
  status: LiveStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  maxParticipants: number;
  recordingNote: string;
}

interface Row {
  id: string;
  course_id: string;
  class_id: string;
  title: string;
  description: string;
  room_token: string;
  status: LiveStatus;
  scheduled_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  max_participants: number;
  recording_note: string;
  courses: { title: string } | null;
}

const SELECT =
  'id, course_id, class_id, title, description, room_token, status, scheduled_at, started_at, ended_at, max_participants, recording_note, courses ( title )';

function toView(row: Row): LiveSessionView {
  return {
    id: row.id,
    courseId: row.course_id,
    courseTitle: row.courses?.title ?? '',
    classId: row.class_id,
    // Filled by `attachClassNames`, one query for the whole page.
    classTitle: '',
    title: row.title,
    description: row.description,
    roomToken: row.room_token,
    status: row.status,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    maxParticipants: row.max_participants,
    recordingNote: row.recording_note,
  };
}

/**
 * The class each session is taught to.
 *
 * Read separately rather than embedded: the session-to-class foreign key is
 * composite (`course_id, class_id`), and a read that silently returns nothing
 * when the embed does not resolve is exactly the failure this codebase keeps
 * meeting. One query for the page's class names is cheap and cannot lie.
 */
async function attachClassNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rows: Row[],
): Promise<LiveSessionView[]> {
  const views = rows.map(toView);
  const ids = [...new Set(rows.map((row) => row.class_id))];
  if (ids.length === 0) return views;

  const { data } = await supabase.from('classes').select('id, name').in('id', ids);
  const names = new Map((data ?? []).map((row) => [row.id, row.name]));
  for (const view of views) view.classTitle = names.get(view.classId) ?? '';
  return views;
}

/** Every class the caller is allowed to see, soonest first. */
export async function listLiveSessions(courseId?: string): Promise<LiveSessionView[]> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();

  let query = supabase
    .from('live_sessions')
    .select(SELECT)
    .order('scheduled_at', { ascending: false, nullsFirst: false })
    .limit(200);
  if (courseId) query = query.eq('course_id', courseId);

  const { data, error } = await query;
  if (error) {
    reportError('live.list', error);
    return [];
  }
  return attachClassNames(supabase, data as unknown as Row[]);
}

export async function getLiveSession(id: string): Promise<LiveSessionView | undefined> {
  if (!supabaseConfigured) return undefined;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('live_sessions')
    .select(SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    reportError('live.get', error, { id });
    return undefined;
  }
  if (!data) return undefined;
  return (await attachClassNames(supabase, [data as unknown as Row]))[0];
}

/**
 * Find a room by its token.
 *
 * Returns nothing for a student without the entitlement — not because this
 * function checks, but because the policy makes the row invisible. That is the
 * point: a forwarded link is not a way in.
 */
export async function getLiveSessionByToken(token: string): Promise<LiveSessionView | undefined> {
  if (!supabaseConfigured) return undefined;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('live_sessions')
    .select(SELECT)
    .eq('room_token', token)
    .maybeSingle();
  if (error) {
    reportError('live.byToken', error);
    return undefined;
  }
  if (!data) return undefined;
  return (await attachClassNames(supabase, [data as unknown as Row]))[0];
}

export interface JoinRequestView {
  id: string;
  userId: string;
  displayName: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
}

/** Who is waiting at the door. Staff-visible; a student sees only their own row. */
export async function listJoinRequests(sessionId: string): Promise<JoinRequestView[]> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('live_join_requests')
    .select('id, user_id, display_name, status, requested_at')
    .eq('session_id', sessionId)
    .order('requested_at', { ascending: true });
  if (error) {
    reportError('live.joinRequests', error, { sessionId });
    return [];
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    status: r.status,
    requestedAt: r.requested_at,
  }));
}

export interface AttendanceView {
  id: string;
  userId: string;
  name: string;
  joinedAt: string;
  leftAt: string | null;
  /** Still in the room as far as the record knows. */
  present: boolean;
  muted: boolean;
  banned: boolean;
}

/**
 * Who was in the room, and when.
 *
 * The attendance rows are the record — a class that happened leaves them
 * behind — so this is the session's log: who joined at what second, who left,
 * and who is still in. Read through the ordinary client, so staff see every
 * row and a student sees only their own.
 */
export async function listAttendance(sessionId: string): Promise<AttendanceView[]> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('live_participants')
    .select('id, user_id, joined_at, left_at, muted, banned_at')
    .eq('session_id', sessionId)
    .order('joined_at', { ascending: true });

  if (error) {
    reportError('live.attendance', error, { sessionId });
    return [];
  }
  if (!data || data.length === 0) return [];

  const ids = [...new Set(data.map((row) => row.user_id))];
  const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', ids);
  const names = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? '']));

  return data.map((row) => ({
    id: row.id,
    userId: row.user_id,
    name: names.get(row.user_id) ?? '',
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    present: row.left_at === null && row.banned_at === null,
    muted: row.muted,
    banned: row.banned_at !== null,
  }));
}

export interface SlideView {
  id: string;
  storageKey: string;
  filename: string;
  byteSize: number;
  order: number;
  /** Signed, short-lived, and minted only for someone `can_read_slide()` approved. */
  url: string | null;
}

/**
 * The deck for one class, WITHOUT signed links.
 *
 * The rows come back through RLS, so a student who does not hold the course
 * gets an empty deck rather than a list of keys to go fishing with.
 *
 * Signing is deliberately not done here. Each URL costs a `can_read_slide`
 * RPC and one HMAC, and the room used to mint the whole deck on every join for
 * every participant — a hundred-page deck was two hundred round trips before
 * anybody saw a page. The room now asks for the page it is about to show
 * (`signSlide`) and for the whole deck only when the slides panel is opened
 * (`roomSlides`), so a passive join mints nothing.
 */
export async function listSlides(sessionId: string): Promise<SlideView[]> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('live_slides')
    .select('id, storage_key, filename, byte_size, display_order')
    .eq('session_id', sessionId)
    .order('display_order');
  if (error) {
    reportError('live.slides', error, { sessionId });
    return [];
  }

  return (data ?? []).map((r) => ({
    id: r.id,
    storageKey: r.storage_key,
    filename: r.filename,
    byteSize: r.byte_size,
    order: r.display_order,
    url: null,
  }));
}

/**
 * A signed link for one slide, minted only for a caller `can_read_slide()`
 * approved.
 *
 * Every slide read goes through here — the preparation screen, the room, the
 * deck re-read below — so the answer to "may this person see this file?" is
 * one function and not three that could drift apart.
 */
export async function slideUrl(key: string): Promise<string | null> {
  if (!supabaseConfigured || !r2Configured) return null;
  const supabase = await createClient();
  const { data: allowed, error } = await supabase.rpc('can_read_slide', { key });
  if (error) {
    reportError('slides.authorize', error);
    return null;
  }
  if (!allowed) return null;
  return signDownload(key);
}

/**
 * A signed link for ONE slide, for a viewer already in the room.
 *
 * This is the on-demand path the classroom uses while presenting: the page
 * being shown gets a URL, and a page nobody shows costs nothing. The session
 * is checked as well as the id — a slide id from another class must not be
 * signable just because the caller can read that class's deck, which is a
 * different question from "is this page of this lesson".
 */
export async function signSlide(sessionId: string, slideId: string): Promise<string | null> {
  if (!supabaseConfigured || !r2Configured) return null;
  if (!z.string().uuid().safeParse(sessionId).success) return null;
  if (!z.string().uuid().safeParse(slideId).success) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('live_slides')
    .select('storage_key')
    .eq('id', slideId)
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) {
    reportError('slides.byId', error, { sessionId, slideId });
    return null;
  }
  if (!data) return null;

  return slideUrl(data.storage_key);
}

/**
 * The deck as it stands, for a viewer already in the room.
 *
 * Called when the teacher adds slides mid-lesson and when a viewer opens the
 * slides panel: each browser reads it for itself. The URLs are minted per
 * caller through `can_read_slide()`, so a slide added during a class is
 * visible to the students entitled to it and to nobody else — which a URL
 * copied out of the teacher's page would not have been.
 */
export async function roomSlides(
  sessionId: string,
): Promise<{ id: string; url: string | null; filename: string }[]> {
  if (!supabaseConfigured) return [];
  if (!z.string().uuid().safeParse(sessionId).success) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('live_slides')
    .select('id, storage_key, filename')
    .eq('session_id', sessionId)
    .order('display_order');
  if (error) {
    reportError('slides.roomList', error, { sessionId });
    return [];
  }

  const rows = data ?? [];
  const urls = await Promise.all(rows.map((r) => slideUrl(r.storage_key)));
  return rows.map((r, i) => ({ id: r.id, url: urls[i] ?? null, filename: r.filename }));
}

/**
 * The classes this viewer can actually walk into, soonest first.
 *
 * No role check is written here, and that is the point: `live_sessions` is
 * readable only for a course the caller holds, so this returns a student's own
 * classes and nothing else. A student with no entitlement gets an empty list
 * from the same query that gives the teacher theirs.
 *
 * Ended and cancelled classes are left out — a finished room cannot be
 * re-entered, so listing it would only offer a door that refuses.
 */
export async function upcomingLiveSessions(limit = 5): Promise<LiveSessionView[]> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('live_sessions')
    .select(SELECT)
    .in('status', ['live', 'scheduled'])
    .order('status', { ascending: false }) // 'scheduled' < 'live' by enum order; live first.
    .order('scheduled_at', { ascending: true, nullsFirst: false })
    .limit(limit);
  if (error) {
    reportError('live.upcoming', error);
    return [];
  }
  return attachClassNames(supabase, data as unknown as Row[]);
}

/** The whiteboard as it stands, for somebody arriving mid-lesson. */
export async function listBoardOps(sessionId: string): Promise<BoardOp[]> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('live_board_ops')
    .select('op')
    .eq('session_id', sessionId)
    .order('id')
    .limit(5000);
  if (error) {
    reportError('live.board', error, { sessionId });
    return [];
  }
  return (data ?? []).map((row) => row.op as unknown as BoardOp);
}

/**
 * The chat so far.
 *
 * Two queries rather than an embedded join, because `live_messages.user_id`
 * points at `auth.users` and not at `profiles` — PostgREST cannot infer a
 * relationship that is not there, and the embed silently returned nothing, so
 * a late joiner saw an empty chat with no error anywhere.
 *
 * Both reads go through RLS: the messages are visible only to someone who can
 * enter the room, and `profiles` is already governed by its own policies.
 */
export async function listMessages(
  sessionId: string,
  limit = 200,
): Promise<{ id: string; name: string; isHost: boolean; body: string; at: number }[]> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('live_messages')
    .select('id, body, created_at, user_id')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    reportError('live.messages', error, { sessionId });
    return [];
  }

  const rows = data ?? [];
  const authorIds = [...new Set(rows.map((r) => r.user_id))];
  const authors = new Map<string, { name: string; isHost: boolean }>();

  if (authorIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, role')
      .in('id', authorIds);
    for (const profile of profiles ?? []) {
      authors.set(profile.id, {
        name: profile.full_name,
        isHost: profile.role === 'admin' || profile.role === 'instructor',
      });
    }
  }

  return rows
    .map((row) => ({
      id: row.id,
      name: authors.get(row.user_id)?.name ?? '',
      isHost: authors.get(row.user_id)?.isHost ?? false,
      body: row.body,
      at: new Date(row.created_at).getTime(),
    }))
    .reverse();
}
