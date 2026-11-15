import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { AttendanceMarker } from '@/components/admin/AttendanceMarker';
import type { SessionRoll } from '@/lib/data/attendance';
import type { AttendanceStatus } from '@/lib/live/attendance';

const TONE: Record<AttendanceStatus, 'success' | 'danger' | 'muted'> = {
  present: 'success',
  absent: 'danger',
  excused: 'muted',
};

const LABEL = {
  present: 'rollPresent',
  absent: 'rollAbsent',
  excused: 'rollExcused',
} as const satisfies Record<AttendanceStatus, string>;

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
  roll,
  locale,
  marksDetail,
}: {
  sessionId: string;
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
          {roll.held && (
            <p className="mt-4 text-[13px] font-medium text-ink" data-testid="roll-totals">
              {t('rollTotals', {
                present: roll.summary.present,
                absent: roll.summary.absent,
                excused: roll.summary.excused,
              })}
            </p>
          )}

          <div className="mt-3 overflow-x-auto rounded-[var(--radius-card)] border border-line">
            <table className="w-full min-w-[620px] border-collapse text-[13px]">
              <thead>
                <tr className="bg-surface/60 text-left text-[11px] tracking-wide text-ink-muted uppercase">
                  <th className="p-3 font-medium">{t('colStudent')}</th>
                  <th className="p-3 font-medium">{t('colStatus')}</th>
                  <th className="p-3 font-medium">{t('rollCorrection')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {roll.rows.map((row) => {
                  // While the class runs there is no "absent" yet — only who
                  // has arrived. A correction already written still shows.
                  const status: AttendanceStatus | null = roll.held
                    ? (row.attendance?.status ?? null)
                    : (row.mark ?? (row.joinedAt ? 'present' : null));
                  const corrected = row.mark !== null;
                  const name = row.name || t('liveGuest');
                  return (
                    <tr key={row.userId} data-user={row.userId} data-status={status ?? 'none'}>
                      <td className="p-3 text-ink">{name}</td>
                      <td className="p-3">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {status ? (
                            <Badge variant={TONE[status]}>{t(LABEL[status])}</Badge>
                          ) : (
                            <span className="text-[12px] text-ink-muted">
                              {roll.held ? t('rollNotCounted') : t('rollNotYet')}
                            </span>
                          )}
                          {corrected && (
                            <span className="text-[11px] text-ink-muted">{t('rollCorrected')}</span>
                          )}
                          {row.joinedAt && (
                            <span className="text-[11px] text-ink-muted tabular-nums">
                              {t('rollArrivedAt', { time: time.format(new Date(row.joinedAt)) })}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <AttendanceMarker
                          sessionId={sessionId}
                          userId={row.userId}
                          name={name}
                          mark={row.mark}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 max-w-2xl text-[11px] leading-relaxed text-ink-muted">
            {t('rollLimit')}
          </p>
        </>
      )}
    </section>
  );
}
