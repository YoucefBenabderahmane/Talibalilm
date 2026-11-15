'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { ActionError } from '@/components/admin/ActionError';
import { setAttendanceMark } from '@/app/actions/live';
import type { AdminState } from '@/app/actions/admin';
import type { AttendanceStatus } from '@/lib/live/attendance';
import { cn } from '@/lib/utils';

const EMPTY: AdminState = { ok: true };

const CHOICES = ['present', 'absent', 'excused', 'auto'] as const;
type Choice = (typeof CHOICES)[number];

const LABEL = {
  present: 'rollPresent',
  absent: 'rollAbsent',
  excused: 'rollExcused',
  auto: 'rollAuto',
} as const satisfies Record<Choice, string>;

/**
 * The teacher's correction for one student at one class.
 *
 * Four choices in one row: the three answers, and "automatique", which removes
 * the correction and returns the class to what the room recorded. The one in
 * force is the pressed one, so the screen always shows whether an answer is
 * the teacher's or the record's.
 *
 * A form posting to a server action: the button that was pressed carries the
 * choice, and the write goes through RLS — the policy is what makes this a
 * staff-only act, not the fact that the button is on an admin screen.
 */
export function AttendanceMarker({
  sessionId,
  userId,
  name,
  mark,
}: {
  sessionId: string;
  userId: string;
  /** For the buttons' accessible names: "Marquer Amina présente". */
  name: string;
  mark: AttendanceStatus | null;
}) {
  const t = useTranslations('admin');
  const [state, action, pending] = useActionState(setAttendanceMark, EMPTY);
  const current: Choice = mark ?? 'auto';

  return (
    <form action={action}>
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="userId" value={userId} />
      <div
        role="group"
        aria-label={t('rollCorrectFor', { name })}
        className="inline-flex flex-wrap overflow-hidden rounded-full border border-line bg-white"
      >
        {CHOICES.map((choice) => (
          <button
            key={choice}
            type="submit"
            name="status"
            value={choice}
            disabled={pending}
            aria-pressed={current === choice}
            className={cn(
              'px-3 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-60',
              current === choice
                ? choice === 'auto'
                  ? 'bg-surface text-ink'
                  : 'bg-brand-500 text-white'
                : 'text-ink-muted hover:bg-brand-50 hover:text-brand-700',
            )}
          >
            {t(LABEL[choice])}
          </button>
        ))}
      </div>
      <ActionError state={state} className="mt-1" />
    </form>
  );
}
