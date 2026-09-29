import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Classroom } from '@/components/live/Classroom';
import {
  getLiveSessionByToken,
  listSlides,
  listBoardOps,
  listMessages,
  listAttendance,
} from '@/lib/data/live';
import { joinRoom } from '@/app/actions/live';
import { currentViewer } from '@/lib/auth/guards';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { liveKitConfigured } from '@/lib/live/server';
import { reportError } from '@/lib/observability/report';
import type { LiveRoomState } from '@/lib/supabase/database.types';
import { requireLocale } from '@/i18n/routing';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The live classroom.
 *
 * The role is settled here, on the server, before a single byte of the room
 * reaches the browser — which is the fix for the bug that started this rewrite.
 * The embedded room it replaced handed every participant the same powers, so
 * the teacher joined their own class as a student. Now `live_room_state`
 * answers from the database and a student's page is rendered without the host
 * controls in it at all.
 *
 * Nothing about that answer is taken on trust later. The same function decides
 * the LiveKit token's publish permission, so a student who forced the controls
 * back into their page would still have no camera the media server accepts.
 */
export default async function LiveRoomPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  if (!supabaseConfigured) redirect('/login');

  const viewer = await currentViewer();
  if (!viewer) redirect(`/login?next=${encodeURIComponent(`/live/${token}`)}`);

  // An RLS-gated read: a student who does not hold the module gets nothing and
  // falls through to notFound(). Holding the link is not holding a key.
  const session = await getLiveSessionByToken(token);
  if (!session) notFound();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('live_room_state', { session_id: session.id });

  const t = await getTranslations('live');

  // An error is not a closed door, and conflating the two sent a teacher
  // looking at their own class wondering who had cancelled it. The commonest
  // cause by far is the migration that defines this function not having been
  // run on the project, so that case is named rather than guessed at.
  if (error) {
    reportError('live.roomState', error, { sessionId: session.id });
    const missing = error.code === 'PGRST202' || error.code === '42883';
    return (
      <main className="flex min-h-dvh items-center justify-center bg-ink px-6 text-center">
        <div className="max-w-md">
          <h1 className="font-display text-xl font-semibold text-white">
            {missing ? t('migrationTitle') : t('errorTitle')}
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-white/60">
            {missing ? t('migrationBody') : t('errorBody')}
          </p>
        </div>
      </main>
    );
  }

  // Null covers not entitled, removed from the class, and class over — all
  // answered the same, because which one it is, is not a student's to learn.
  if (!data) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-ink px-6 text-center">
        <div className="max-w-sm">
          <h1 className="font-display text-xl font-semibold text-white">{t('closedTitle')}</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-white/60">
            {viewer.role === 'admin' || viewer.role === 'instructor'
              ? t('closedBodyStaff')
              : t('closedBody')}
          </p>
        </div>
      </main>
    );
  }

  if (!liveKitConfigured) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-ink px-6 text-center">
        <div className="max-w-md">
          <h1 className="font-display text-xl font-semibold text-white">
            {t('notConfiguredTitle')}
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-white/60">{t('notConfiguredBody')}</p>
        </div>
      </main>
    );
  }

  const room: LiveRoomState = data;

  // Attendance, and the lesson so far. Best-effort on the log: a failure to
  // record that somebody arrived must never be why they cannot attend.
  //
  // The roll is read for the teacher alone — a ban is theirs to undo, and a
  // student has no use for the list of people removed from the class.
  const [slides, boardHistory, chatHistory, attendance] = await Promise.all([
    listSlides(session.id),
    listBoardOps(session.id),
    listMessages(session.id),
    room.is_host ? listAttendance(session.id) : Promise.resolve([]),
    joinRoom(session.id).catch(() => {}),
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  const safeTitle = session.title
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  return (
    <Classroom
      roomToken={session.roomToken}
      sessionId={session.id}
      title={session.title}
      room={room}
      slides={slides.map((s) => ({ id: s.id, url: s.url, filename: s.filename }))}
      boardHistory={boardHistory}
      chatHistory={chatHistory}
      removedPeople={attendance
        .filter((row) => row.banned)
        .map((row) => ({ userId: row.userId, name: row.name }))}
      recordingBaseName={`${safeTitle || t('recording')}-${stamp}`}
    />
  );
}
