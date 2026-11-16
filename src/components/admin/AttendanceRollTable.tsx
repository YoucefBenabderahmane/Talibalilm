'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { AttendanceMarker } from '@/components/admin/AttendanceMarker';
import {
  resolveAttendance,
  summarizeAttendance,
  type AttendanceSession,
  type AttendanceStatus,
} from '@/lib/live/attendance';

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

export interface RollTableRow {
  userId: string;
  name: string;
  joinedAt: string | null;
  /** `joinedAt` already formatted by the server, so both renders agree. */
  arrivedAt: string | null;
  mark: AttendanceStatus | null;
  memberSince: string | null;
}

/**
 * The totals and the table of the roll, kept in step with each correction.
 *
 * The marks live here, and a correction updates them from the action's own
 * answer: the row, its « corrigé » hint and the totals change the moment the
 * database has accepted it, without re-rendering the page. The answer for each
 * row comes from `resolveAttendance`, the rule the server and the student's
 * page use, so the three cannot disagree.
 */
export function AttendanceRollTable({
  sessionId,
  session,
  held,
  rows,
}: {
  sessionId: string;
  session: AttendanceSession;
  held: boolean;
  rows: RollTableRow[];
}) {
  const t = useTranslations('admin');
  const [marks, setMarks] = useState<Record<string, AttendanceStatus | null>>(() =>
    Object.fromEntries(rows.map((row) => [row.userId, row.mark])),
  );
  const onSaved = useCallback((userId: string, mark: AttendanceStatus | null) => {
    setMarks((current) => ({ ...current, [userId]: mark }));
  }, []);

  const resolved = rows.map((row) => {
    const mark = marks[row.userId] ?? null;
    // While the class runs there is no "absent" yet, only who has arrived.
    // A correction already written still shows.
    const status: AttendanceStatus | null = held
      ? (resolveAttendance({
          session,
          joined: row.joinedAt !== null,
          mark,
          memberSince: row.memberSince,
        })?.status ?? null)
      : (mark ?? (row.joinedAt ? 'present' : null));
    return { row, mark, status };
  });
  const summary = summarizeAttendance(resolved.map(({ status }) => (status ? { status } : null)));

  return (
    <>
      {held && (
        <p className="mt-4 text-[13px] font-medium text-ink" data-testid="roll-totals">
          {t('rollTotals', {
            present: summary.present,
            absent: summary.absent,
            excused: summary.excused,
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
            {resolved.map(({ row, mark, status }) => {
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
                          {held ? t('rollNotCounted') : t('rollNotYet')}
                        </span>
                      )}
                      {mark !== null && (
                        <span className="text-[11px] text-ink-muted">{t('rollCorrected')}</span>
                      )}
                      {row.arrivedAt && (
                        <span className="text-[11px] text-ink-muted tabular-nums">
                          {t('rollArrivedAt', { time: row.arrivedAt })}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-3">
                    <AttendanceMarker
                      sessionId={sessionId}
                      userId={row.userId}
                      name={name}
                      mark={mark}
                      onSaved={onSaved}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
