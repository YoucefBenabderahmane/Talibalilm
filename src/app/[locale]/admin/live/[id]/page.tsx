import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { BackLink } from '@/components/admin/BackLink';
import { Badge } from '@/components/ui/badge';
import { LiveSessionControls } from '@/components/admin/LiveSessionControls';
import { AttendanceRoll } from '@/components/admin/AttendanceRoll';
import { getLiveSession, listAttendance } from '@/lib/data/live';
import { sessionRoll } from '@/lib/data/attendance';
import { errorDetail } from '@/lib/supabase/error-detail';
import { requireStaff } from '@/lib/auth/guards';
import type { LiveStatus } from '@/lib/supabase/database.types';
import { requireLocale } from '@/i18n/routing';

/**
 * One live class: its deck, its door, and the controls to run it.
 *
 * The deck lives here rather than in the room because a teacher builds it
 * before the class and the room is a full-screen surface with no space for
 * file management. During the class the slides are presented by sharing the
 * screen — so this page is preparation, and the room is delivery.
 */
export default async function AdminLiveSessionPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  await requireStaff();
  const t = await getTranslations('admin');

  const session = await getLiveSession(id);
  if (!session) notFound();

  // The roll is for a class that has begun: before that nobody is expected,
  // and a cancelled class was not held. Read with the log, not after it.
  const started = session.status === 'live' || session.status === 'ended';
  const [attendance, roll] = await Promise.all([
    listAttendance(id),
    started
      ? sessionRoll({
          id: session.id,
          classId: session.classId,
          status: session.status,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
        })
      : Promise.resolve(null),
  ]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' });
  // The log is read to the second: "he joined at 18:31:04" settles an argument
  // that "he was late" does not.
  const logFmt = new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
  const label: Record<LiveStatus, string> = {
    scheduled: t('liveStatusScheduled'),
    live: t('liveStatusLive'),
    ended: t('liveStatusEnded'),
    cancelled: t('liveStatusCancelled'),
  };
  const tone: Record<LiveStatus, 'success' | 'soft' | 'muted' | 'danger'> = {
    scheduled: 'soft',
    live: 'success',
    ended: 'muted',
    cancelled: 'danger',
  };

  return (
    <div className="max-w-4xl">
      <BackLink href="/admin/live" label={t('liveTitle')} />

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-semibold text-ink">{session.title}</h1>
        <Badge variant={tone[session.status]}>{label[session.status]}</Badge>
      </div>
      <p className="mt-1 text-[13px] text-ink-muted">
        {session.courseTitle}
        {' · '}
        {session.scheduledAt ? when.format(new Date(session.scheduledAt)) : t('liveNotScheduled')}
        {' · '}
        {t('liveCapacityShort', { count: session.maxParticipants })}
      </p>

      <div className="mt-5">
        <LiveSessionControls
          id={session.id}
          roomToken={session.roomToken}
          status={session.status}
        />
      </div>

      {/* Who was missing — the question the log below cannot answer, because
          an absent student is the one with no line in it. */}
      {roll && (
        <AttendanceRoll
          sessionId={session.id}
          roll={roll}
          locale={locale}
          marksDetail={roll.marksError ? errorDetail(roll.marksError) : undefined}
        />
      )}

      {/* The log. A class that happened leaves its attendance behind, and
          "who was there, at what time" is the question the office actually
          asks — the deck is managed inside the room now, where it is used. */}
      <section className="mt-10">
        <h2 className="font-display text-[15px] font-semibold text-ink">{t('liveLogTitle')}</h2>
        <p className="mt-1 text-[12px] text-ink-muted">{t('liveLogLead')}</p>

        {attendance.length === 0 ? (
          <p className="mt-4 rounded-[var(--radius-card)] border border-dashed border-line bg-surface/50 p-6 text-center text-[13px] text-ink-muted">
            {t('liveDoorEmpty')}
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-[var(--radius-card)] border border-line">
            <table className="w-full min-w-[560px] border-collapse text-[13px]">
              <thead>
                <tr className="bg-surface/60 text-left text-[11px] tracking-wide text-ink-muted uppercase">
                  <th className="p-3 font-medium">{t('colStudent')}</th>
                  <th className="p-3 font-medium">{t('liveJoinedAt')}</th>
                  <th className="p-3 font-medium">{t('liveLeftAt')}</th>
                  <th className="p-3 font-medium">{t('colStatus')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {attendance.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-brand-50/40">
                    <td className="p-3 text-ink">{row.name || t('liveGuest')}</td>
                    <td className="p-3 whitespace-nowrap text-ink-muted tabular-nums">
                      {logFmt.format(new Date(row.joinedAt))}
                    </td>
                    <td className="p-3 whitespace-nowrap text-ink-muted tabular-nums">
                      {row.leftAt ? logFmt.format(new Date(row.leftAt)) : '—'}
                    </td>
                    <td className="p-3">
                      {row.banned ? (
                        <Badge variant="danger">{t('liveRefuse')}</Badge>
                      ) : row.present ? (
                        <Badge variant="success">{t('livePresent')}</Badge>
                      ) : (
                        <Badge variant="muted">{t('liveLeft')}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
