import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { History } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { myPastClasses, type MyAttendance } from '@/lib/data/attendance';
import type { AttendanceStatus } from '@/lib/live/attendance';
import { safeLocale } from '@/i18n/routing';

const TONE: Record<AttendanceStatus, 'success' | 'danger' | 'muted'> = {
  present: 'success',
  absent: 'danger',
  excused: 'muted',
};

const LABEL = {
  present: 'attendancePresent',
  absent: 'attendanceAbsent',
  excused: 'attendanceExcused',
} as const satisfies Record<AttendanceStatus, string>;

/**
 * The classes a student's group has held, and whether they were there.
 *
 * A live class used to leave no trace for the student once it was over: the
 * dashboard listed the ones to come, and a past one was simply gone. This is
 * the other half — each class their group held, marked Présent, Absent or
 * Excusé, with how many they attended in all.
 *
 * Nothing here checks who may see what. `myPastClasses` reads through RLS:
 * the classes of the group the student sits in, their own attendance rows and
 * the corrections about them. The answer for each is `resolveAttendance`, the
 * same rule the teacher's roll uses.
 */
export async function PastClasses({
  locale,
  userId,
  courseId,
  limit = 5,
}: {
  locale: string;
  userId: string;
  /** Narrows to one module, for the module's home. Omitted on the dashboard. */
  courseId?: string;
  limit?: number;
}) {
  const attendance = await myPastClasses(userId, { courseId, limit });
  if (attendance.summary.total === 0) return null;

  const t = await getTranslations('live');
  return (
    <PastClassesList
      attendance={attendance}
      locale={locale}
      heading={t('pastClasses')}
      showCourse={!courseId}
    />
  );
}

/** The list itself, from data already read — also what the browser tests render. */
export function PastClassesList({
  attendance,
  locale,
  heading,
  showCourse,
}: {
  attendance: MyAttendance;
  locale: string;
  heading: string;
  /** The module's name on each row: useful on the dashboard, noise on the module's own page. */
  showCourse: boolean;
}) {
  const t = useTranslations('live');
  const { classes, summary } = attendance;
  const when = new Intl.DateTimeFormat(safeLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <section data-testid="past-classes">
      <h2 className="flex items-center gap-2 font-display text-xl font-semibold text-ink">
        <History className="size-4 text-brand-500" aria-hidden="true" />
        {heading}
      </h2>
      <p className="mt-1 text-[12px] text-ink-muted" data-testid="attendance-summary">
        {t('attendanceSummary', { present: summary.present, total: summary.total })}
        {summary.excused > 0 && ` · ${t('attendanceExcusedCount', { count: summary.excused })}`}
      </p>

      <ul className="mt-4 space-y-2">
        {classes.map((session) => (
          <li
            key={session.id}
            data-status={session.status}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-card)] border border-line bg-white p-4"
          >
            <div className="min-w-0 flex-1">
              <p className="font-display text-[14px] font-semibold text-ink">{session.title}</p>
              <p className="text-[11px] text-ink-muted">
                {showCourse && session.courseTitle && `${session.courseTitle} · `}
                {when.format(new Date(session.startedAt))}
              </p>
            </div>
            <Badge variant={TONE[session.status]}>{t(LABEL[session.status])}</Badge>
          </li>
        ))}
      </ul>

      {summary.absent > 0 && (
        <p className="mt-3 text-[11px] leading-relaxed text-ink-muted">
          {t('attendanceAbsentHint')}
        </p>
      )}
    </section>
  );
}
