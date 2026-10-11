import { getTranslations } from 'next-intl/server';
import { Radio, Video } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { upcomingLiveSessions } from '@/lib/data/live';
import { safeLocale } from '@/i18n/routing';

/**
 * A student's live classes, on the dashboard and on the course they bought.
 *
 * This is the piece the school was missing: the teacher could open a room but
 * nobody could find it without being sent the link by hand. There is no access
 * check written here — `upcomingLiveSessions` reads through RLS, so this
 * renders exactly the classes the viewer holds the course for and nothing else.
 *
 * A class that is live says so and offers the door. A scheduled one shows when,
 * and the same button, because the room is open to gather in before the teacher
 * starts — which is how a class of fifty actually assembles on time.
 */
export async function UpcomingClasses({
  locale,
  courseId,
  limit = 5,
}: {
  locale: string;
  /** Narrows to one course, for the course page. Omitted on the dashboard. */
  courseId?: string;
  limit?: number;
}) {
  const t = await getTranslations('live');
  const all = await upcomingLiveSessions(limit);
  const sessions = courseId ? all.filter((s) => s.courseId === courseId) : all;

  if (sessions.length === 0) return null;

  const when = new Intl.DateTimeFormat(safeLocale(locale), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section>
      <h2 className="flex items-center gap-2 font-display text-xl font-semibold text-ink">
        <Radio className="size-4 text-brand-500" aria-hidden="true" />
        {t('myClasses')}
      </h2>

      <ul className="mt-4 space-y-3">
        {sessions.map((session) => {
          const live = session.status === 'live';
          return (
            <li
              key={session.id}
              className="flex flex-wrap items-center gap-4 rounded-[var(--radius-card)] border border-line bg-white p-4"
            >
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
                  live ? 'bg-red-50 text-red-600' : 'bg-brand-50 text-brand-600'
                }`}
                aria-hidden="true"
              >
                <Video className="size-4" />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-display text-[15px] font-semibold text-ink">{session.title}</p>
                  {live && <Badge variant="danger">{t('liveNow')}</Badge>}
                </div>
                <p className="text-[11px] text-ink-muted">
                  {session.courseTitle}
                  {/* The group it is taught to: a student only ever sees their
                      own here, staff see which class each session belongs to. */}
                  {session.classTitle && ` · ${session.classTitle}`}
                  {session.scheduledAt && ` · ${when.format(new Date(session.scheduledAt))}`}
                </p>
              </div>

              <Button asChild size="sm" variant={live ? 'primary' : 'outline'}>
                <Link href={`/live/${session.roomToken}`}>
                  {live ? t('joinNow') : t('openRoom')}
                </Link>
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
