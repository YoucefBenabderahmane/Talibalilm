import { useTranslations } from 'next-intl';
import { AttendanceRollTable } from '@/components/admin/AttendanceRollTable';
import type { SessionRoll } from '@/lib/data/attendance';
import type { AttendanceSession } from '@/lib/live/attendance';

/**
 * The roll of one class: every student of its group, present or not, with the
 * control to correct each.
 *
 * The log below it on the same screen answers "who came, and when". This
 * answers the question the office asks next — "who was missing" — which the
 * log cannot, because an absent student is exactly the one with no line in it.
 *
 * What the room records is who opened it online, so the screen says so, and
 * says what that misses: an on-site student, a failed connection, somebody who
 * looked in and left before the class began. Those are what the correction is
 * for.
 */
export function AttendanceRoll({
  sessionId,
  session,
  roll,
  locale,
  marksDetail,
}: {
  sessionId: string;
  session: AttendanceSession;
  roll: SessionRoll;
  locale: string;
  /** What the database said when the corrections could not be read. */
  marksDetail?: string;
}) {
  const t = useTranslations('admin');
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });

  return (
    <section className="mt-10" data-testid="attendance-roll">
      <h2 className="font-display text-[15px] font-semibold text-ink">{t('rollTitle')}</h2>
      <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-ink-muted">{t('rollLead')}</p>

      {!roll.held && (
        <p className="mt-3 inline-block rounded-full bg-gold-100 px-3 py-1 text-[11px] font-medium text-gold-700">
          {t('rollProvisional')}
        </p>
      )}

      {/* The cause, not only our reading of it: the corrections table arrives
          with its own migration, and until it has run every correction fails. */}
      {marksDetail && (
        <div className="mt-4">
          <p role="alert" className="text-[12px] text-red-600">
            {t('rollMigrationMissing')}
          </p>
          <pre className="mt-2 overflow-x-auto rounded-[var(--radius-input)] border border-red-200 bg-red-50/60 p-3 text-[11px] leading-relaxed break-words whitespace-pre-wrap text-red-900">
            {marksDetail}
          </pre>
        </div>
      )}

      {roll.rows.length === 0 ? (
        <p className="mt-4 rounded-[var(--radius-card)] border border-dashed border-line bg-surface/50 p-6 text-center text-[13px] text-ink-muted">
          {t('rollEmpty')}
        </p>
      ) : (
        <>
          {/* Keyed on the stored marks: when the page is re-read, the
              database's answer replaces what the table remembered. */}
          <AttendanceRollTable
            key={roll.rows.map((row) => row.mark ?? '-').join()}
            sessionId={sessionId}
            session={session}
            held={roll.held}
            rows={roll.rows.map((row) => ({
              userId: row.userId,
              name: row.name,
              joinedAt: row.joinedAt,
              arrivedAt: row.joinedAt ? time.format(new Date(row.joinedAt)) : null,
              mark: row.mark,
              memberSince: row.memberSince,
            }))}
          />

          <p className="mt-3 max-w-2xl text-[11px] leading-relaxed text-ink-muted">
            {t('rollLimit')}
          </p>
        </>
      )}
    </section>
  );
}
