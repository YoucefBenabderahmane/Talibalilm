'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { requireStaff } from '@/lib/auth/guards';
import type { AdminState } from '@/app/actions/admin';
import { errorDetail } from '@/lib/supabase/error-detail';
import { reportError } from '@/lib/observability/report';
import { applyPermissions, evictParticipant } from '@/lib/live/server';

/**
 * Running a live class.
 *
 * Every write goes through the ordinary anon-key client, so the `is_staff()`
 * policies on `live_sessions` are the control — the same rule the rest of the
 * admin follows. Joining and leaving go through the security-definer functions
 * instead, because those must answer "may this person be here?" identically for
 * the classroom page, the attendance log and any future token route.
 */

const OK: AdminState = { ok: true };

async function staffClient() {
  if (!supabaseConfigured) throw new Error('unavailable');
  await requireStaff();
  return createClient();
}

const createSchema = z.object({
  courseId: z.string().uuid(),
  // A session is taught to one class of one module. The composite foreign key
  // refuses a class that belongs to another course, so a form bug cannot file
  // a Fiqh class under Hadith.
  classId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  // `datetime-local` gives no zone; the browser's own offset is attached below.
  scheduledAt: z.string().trim().max(40).optional(),
  maxParticipants: z.coerce.number().int().min(2).max(500).default(50),
});

export async function createLiveSession(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const parsed = createSchema.safeParse({
    courseId: formData.get('courseId'),
    classId: formData.get('classId'),
    title: formData.get('title'),
    description: formData.get('description') ?? '',
    scheduledAt: (formData.get('scheduledAt') as string) || undefined,
    maxParticipants: formData.get('maxParticipants') || 50,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  const when = parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null;
  if (when && Number.isNaN(when.getTime())) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { error } = await supabase.from('live_sessions').insert({
    course_id: parsed.data.courseId,
    class_id: parsed.data.classId,
    title: parsed.data.title,
    description: parsed.data.description,
    scheduled_at: when ? when.toISOString() : null,
    max_participants: parsed.data.maxParticipants,
  });
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/live', 'page');
  return OK;
}

const idSchema = z.object({ id: z.string().uuid() });

/**
 * Open the room.
 *
 * `started_at` is stamped once and kept: a host who reloads mid-class must not
 * reset the clock the attendance list is read against.
 */
export async function startLiveSession(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = idSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { data: existing } = await supabase
    .from('live_sessions')
    .select('started_at')
    .eq('id', parsed.data.id)
    .maybeSingle();

  const { error } = await supabase
    .from('live_sessions')
    .update({
      status: 'live',
      started_at: existing?.started_at ?? new Date().toISOString(),
      ended_at: null,
    })
    .eq('id', parsed.data.id);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/live', 'page');
  return OK;
}

export async function endLiveSession(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = idSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { error } = await supabase
    .from('live_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', parsed.data.id);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  // Ending the class closes the door for everyone: `can_join_live` refuses an
  // ended session, so nobody wanders back in afterwards.
  revalidatePath('/[locale]/admin/live', 'page');
  return OK;
}

export async function cancelLiveSession(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const parsed = idSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { error } = await supabase
    .from('live_sessions')
    .update({ status: 'cancelled' })
    .eq('id', parsed.data.id);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/live', 'page');
  return OK;
}

/**
 * Remove a class that is over and done with.
 *
 * Only a finished or cancelled one: deleting a room while people are in it
 * would drop their attendance rows under them, and a scheduled class that
 * disappears is a class the students were told about and can no longer find.
 * Cancel first, then delete — which is also the order that leaves the students
 * a visible explanation rather than a hole.
 */
export async function deleteLiveSession(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const parsed = idSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { data: session } = await supabase
    .from('live_sessions')
    .select('status')
    .eq('id', parsed.data.id)
    .maybeSingle();

  if (!session) return { ok: false, error: 'saveFailed' };
  if (session.status !== 'ended' && session.status !== 'cancelled') {
    return { ok: false, error: 'liveStillOpen' };
  }

  // Attendance and join requests cascade with the session.
  const { error } = await supabase.from('live_sessions').delete().eq('id', parsed.data.id);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/live', 'page');
  return OK;
}

/** Note where the recording ended up, so "was this class recorded?" stays answerable. */
export async function noteRecording(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({ id: z.string().uuid(), note: z.string().trim().max(500).default('') })
    .safeParse({ id: formData.get('id'), note: formData.get('note') ?? '' });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { error } = await supabase
    .from('live_sessions')
    .update({ recording_note: parsed.data.note })
    .eq('id', parsed.data.id);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/live', 'page');
  return OK;
}

/** Admit or refuse someone waiting at the door. The RPC re-checks staff itself. */
export async function decideJoinRequest(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const parsed = z.object({ requestId: z.string().uuid(), admit: z.coerce.boolean() }).safeParse({
    requestId: formData.get('requestId'),
    admit: formData.get('admit') === 'yes',
  });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { error } = await supabase.rpc('live_decide_join', {
    request_id: parsed.data.requestId,
    admit: parsed.data.admit,
  });
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/live', 'page');
  return OK;
}

/**
 * Record that the caller entered or left a room.
 *
 * Called from the classroom page, not from an admin screen, so it deliberately
 * does NOT require staff — `live_join` refuses anyone `can_join_live` refuses,
 * which is the entitlement check.
 */
export async function joinRoom(sessionId: string): Promise<void> {
  if (!supabaseConfigured) return;
  const supabase = await createClient();
  await supabase.rpc('live_join', { session_id: sessionId });
}

export async function leaveRoom(sessionId: string): Promise<void> {
  if (!supabaseConfigured) return;
  const supabase = await createClient();
  await supabase.rpc('live_leave', { session_id: sessionId });
}

// ---------------------------------------------------------------------------
// Host controls
//
// The teacher's decision lands in two places, and both matter.
//
// The database is the record: a student muted by the teacher who reloads must
// come back muted, so it is a column rather than a message that was shouted
// once. `live_set_participant` is a security-definer RPC gated on `is_staff()`,
// so the refusal is the database's and the audit names the real teacher.
//
// LiveKit is the enforcement, now: rewriting the live permission means the
// microphone stops being accepted by the media server during the lesson that is
// happening, rather than at the student's next join. Without that half, "mute"
// would be a note for later.
//
// The order is deliberate. The database write happens first and is the one that
// must succeed; the LiveKit call is best-effort, because if it fails the
// decision is still recorded and takes effect when they reconnect.
// ---------------------------------------------------------------------------

const controlSchema = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  action: z.enum([
    'mute',
    'unmute',
    'allow-camera',
    'deny-camera',
    'allow-screen',
    'deny-screen',
    // One approval for the two things a student needs to take part: unmute and
    // allow the camera. Separate buttons were a teacher's two clicks for one
    // decision, and the wrong one got pressed.
    'allow-speak',
    'deny-speak',
    'remove',
    'restore',
  ]),
});

export async function controlParticipant(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const parsed = controlSchema.safeParse({
    sessionId: formData.get('sessionId'),
    userId: formData.get('userId'),
    action: formData.get('action'),
  });
  if (!parsed.success) return { ok: false, error: 'invalid' };
  const { sessionId, userId, action } = parsed.data;

  const supabase = await staffClient();

  // Nothing is derived from the form beyond which button was pressed: what the
  // action means is decided here, and whether the caller may do it at all is
  // decided inside the RPC.
  const args = {
    target_session: sessionId,
    target_user: userId,
    set_muted:
      action === 'mute' || action === 'deny-speak'
        ? true
        : action === 'unmute' || action === 'allow-speak'
          ? false
          : null,
    set_camera:
      action === 'allow-camera' || action === 'allow-speak'
        ? true
        : action === 'deny-camera' || action === 'deny-speak'
          ? false
          : null,
    set_screen: action === 'allow-screen' ? true : action === 'deny-screen' ? false : null,
    set_banned: action === 'remove' ? true : action === 'restore' ? false : null,
  };

  const { error } = await supabase.rpc('live_set_participant', args);
  if (error) {
    reportError('live.control', error, { sessionId, action });
    return {
      ok: false,
      error: error.code === '42501' ? 'notAdmin' : 'saveFailed',
      detail: errorDetail(error),
    };
  }

  // Read back what the database now says rather than assuming the write did
  // what the form asked — the RPC may have refused part of it, and the live
  // permission must reflect the record, not the request.
  const [{ data: session }, { data: participant }] = await Promise.all([
    supabase
      .from('live_sessions')
      .select('room_token, student_camera, student_screen')
      .eq('id', sessionId)
      .maybeSingle(),
    supabase
      .from('live_participants')
      .select('muted, camera_allowed, screen_allowed, banned_at')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .is('left_at', null)
      .maybeSingle(),
  ]);

  if (session && participant) {
    if (participant.banned_at) {
      // Disconnect them now rather than waiting for the token to lapse.
      await evictParticipant(session.room_token, userId);
    } else {
      await applyPermissions(session.room_token, userId, {
        isHost: false,
        muted: participant.muted,
        cameraAllowed: session.student_camera || participant.camera_allowed,
        screenAllowed: session.student_screen || participant.screen_allowed,
      });
    }
  }

  revalidatePath('/[locale]/admin/live/[id]', 'page');
  return OK;
}

/** Room-wide switches: the chat, and whether students may use a camera unasked. */
const roomPolicySchema = z.object({
  sessionId: z.string().uuid(),
  chatEnabled: z.boolean().optional(),
  studentCamera: z.boolean().optional(),
  studentScreen: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
});

export async function setRoomPolicy(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const bool = (name: string) => {
    const raw = formData.get(name);
    return raw === null ? undefined : raw === 'yes';
  };

  const parsed = roomPolicySchema.safeParse({
    sessionId: formData.get('sessionId'),
    chatEnabled: bool('chatEnabled'),
    studentCamera: bool('studentCamera'),
    studentScreen: bool('studentScreen'),
    requireApproval: bool('requireApproval'),
  });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const { sessionId, ...flags } = parsed.data;
  // Only the switches the form actually carried are written, so one toggle
  // cannot silently reset the others to their defaults.
  const row = {
    ...(flags.chatEnabled !== undefined && { chat_enabled: flags.chatEnabled }),
    ...(flags.studentCamera !== undefined && { student_camera: flags.studentCamera }),
    ...(flags.studentScreen !== undefined && { student_screen: flags.studentScreen }),
    ...(flags.requireApproval !== undefined && { require_approval: flags.requireApproval }),
  };
  if (Object.keys(row).length === 0) return OK;

  const supabase = await staffClient();
  const { error } = await supabase.from('live_sessions').update(row).eq('id', sessionId);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/live/[id]', 'page');
  return OK;
}

// ---------------------------------------------------------------------------
// The lesson's own record
//
// Ably — now LiveKit — delivers a message to the people in the room. These
// write it down, so that somebody joining halfway through sees the chat and the
// whiteboard as they stand, and so the school still has the class afterwards.
// Delivery and persistence are separate jobs and neither substitutes for the
// other: a failed insert must not swallow a message the room already showed.
//
// None of these check who is calling. They do not need to: `live_messages`
// refuses a muted student and a closed chat by policy, and `live_board_ops`
// admits staff only. The database is the gate, here as everywhere.
// ---------------------------------------------------------------------------

export async function clearBoard(sessionId: string): Promise<AdminState> {
  if (!z.string().uuid().safeParse(sessionId).success) return { ok: false, error: 'invalid' };
  const supabase = await staffClient();
  // Deleting rather than stamping a marker keeps a late joiner's replay bounded
  // by what is still on the board, which is the whole point of storing ops.
  const { error } = await supabase.from('live_board_ops').delete().eq('session_id', sessionId);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };
  return OK;
}

/** End the class from inside the room, where there is no form to submit. */
export async function endLiveSessionById(sessionId: string): Promise<AdminState> {
  if (!z.string().uuid().safeParse(sessionId).success) return { ok: false, error: 'invalid' };
  const supabase = await staffClient();
  const { error } = await supabase
    .from('live_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', sessionId);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  revalidatePath('/[locale]/admin/live', 'page');
  return OK;
}
