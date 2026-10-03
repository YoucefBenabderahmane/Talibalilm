import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { BackLink } from '@/components/admin/BackLink';
import { Badge } from '@/components/ui/badge';
import { LiveSessionForm } from '@/components/admin/LiveSessionForm';
import { LiveSessionControls } from '@/components/admin/LiveSessionControls';
import { listLiveSessions } from '@/lib/data/live';
import { listClasses } from '@/lib/data/classes';
import { requireStaff } from '@/lib/auth/guards';
import { createClient } from '@/lib/supabase/server';
import type { LiveStatus } from '@/lib/supabase/database.types';
import { requireLocale } from '@/i18n/routing';

/**
 * Live classes.
 *
 * The school runs its own classroom rather than paying per seat and stopping at
 * forty minutes. What it does not run is its own paywall: a class belongs to a
 * course, and `has_course_access()` decides who gets in — the same gate as the
 * lessons, so there is nothing here to keep in step by hand.
 */
export default async function AdminLivePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  await requireStaff();
  const t = await getTranslations('admin');

  const supabase = await createClient();
  const [sessions, { data: courses }, classes] = await Promise.all([
    listLiveSessions(),
    supabase.from('courses').select('id, title').order('display_order'),
    listClasses(),
  ]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

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
      <BackLink href="/admin" label={t('navOverview')} />
      <h1 className="font-display text-2xl font-semibold text-ink">{t('liveTitle')}</h1>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-muted">{t('liveLead')}</p>

      <section className="mt-8">
        <h2 className="font-display text-[15px] font-semibold text-ink">{t('liveNew')}</h2>
        <div className="mt-3">
          <LiveSessionForm courses={courses ?? []} classes={classes} />
        </div>
      </section>

      {/* One table, history included: a session that has ended is the record
          of a class that happened, not something to sweep away. */}
      <section className="mt-10">
        {sessions.length === 0 ? (
          <p className="rounded-[var(--radius-card)] border border-dashed border-line bg-surface/50 p-6 text-center text-sm text-ink-muted">
            {t('liveNone')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line">
            <table className="w-full min-w-[720px] border-collapse text-[13px]">
              <thead>
                <tr className="bg-surface/60 text-left text-[11px] tracking-wide text-ink-muted uppercase">
                  <th className="p-3 font-medium">{t('liveCourse')}</th>
                  <th className="p-3 font-medium">{t('liveClassGroup')}</th>
                  <th className="p-3 font-medium">{t('liveClassTitle')}</th>
                  <th className="p-3 font-medium">{t('colStarted')}</th>
                  <th className="p-3 font-medium">{t('colEnded')}</th>
                  <th className="p-3 font-medium">{t('colDuration')}</th>
                  <th className="p-3 font-medium">{t('colStatus')}</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sessions.map((s) => {
                  const duration =
                    s.startedAt && s.endedAt
                      ? Math.max(
                          0,
                          Math.round(
                            (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) /
                              60000,
                          ),
                        )
                      : null;
                  return (
                    <tr key={s.id} className="transition-colors hover:bg-brand-50/40">
                      <td className="p-3 text-ink-muted">{s.courseTitle}</td>
                      <td className="p-3 text-ink-muted">{s.classTitle}</td>
                      <td className="p-3">
                        <Link
                          href={`/admin/live/${s.id}`}
                          className="font-medium text-ink transition-colors hover:text-brand-600"
                        >
                          {s.title}
                        </Link>
                      </td>
                      <td className="p-3 whitespace-nowrap text-ink-muted">
                        {s.startedAt ? when.format(new Date(s.startedAt)) : '—'}
                      </td>
                      <td className="p-3 whitespace-nowrap text-ink-muted">
                        {s.endedAt ? when.format(new Date(s.endedAt)) : '—'}
                      </td>
                      <td className="p-3 whitespace-nowrap text-ink-muted tabular-nums">
                        {duration === null ? '—' : t('minutesShort', { count: duration })}
                      </td>
                      <td className="p-3">
                        <Badge variant={tone[s.status]}>{label[s.status]}</Badge>
                      </td>
                      <td className="p-3">
                        <LiveSessionControls id={s.id} roomToken={s.roomToken} status={s.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
