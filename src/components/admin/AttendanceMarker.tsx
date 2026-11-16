'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ActionError } from '@/components/admin/ActionError';
import { setAttendanceMark, type AttendanceMarkState } from '@/app/actions/live';
import type { AttendanceStatus } from '@/lib/live/attendance';
import { cn } from '@/lib/utils';

const EMPTY: AttendanceMarkState = { ok: true };

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
 * The write goes through RLS: the policy is what makes this a staff-only act,
 * not the fact that the button is on an admin screen.
 *
 * Called from the click, not through `<form action>` and `useActionState`.
 * Those tie the busy state to a router transition, and a transition that
 * React loses track of leaves the buttons disabled for good (see
 * `setAttendanceMark`). Here the busy state is this component's own, and it
 * ends when the database has answered.
 */
export function AttendanceMarker({
  sessionId,
  userId,
  name,
  mark,
  onSaved,
}: {
  sessionId: string;
  userId: string;
  /** For the buttons' accessible names: "Marquer Amina présente". */
  name: string;
  mark: AttendanceStatus | null;
  /** Called with the mark the database now holds for this student. */
  onSaved: (userId: string, mark: AttendanceStatus | null) => void;
}) {
  const t = useTranslations('admin');
  const [state, setState] = useState<AttendanceMarkState>(EMPTY);
  const [pending, setPending] = useState(false);
  const current: Choice = mark ?? 'auto';

  async function choose(choice: Choice) {
    if (pending || choice === current) return;
    setPending(true);
    const form = new FormData();
    form.set('sessionId', sessionId);
    form.set('userId', userId);
    form.set('status', choice);
    try {
      const result = await setAttendanceMark(EMPTY, form);
      setState(result);
      if (result.ok) onSaved(userId, result.mark ?? null);
    } catch (error) {
      // The request itself failed (network, server down). Say so, with what
      // the browser reported, rather than leaving the old answer looking saved.
      setState({
        ok: false,
        error: 'saveFailed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div
        role="group"
        aria-label={t('rollCorrectFor', { name })}
        aria-busy={pending}
        className="inline-flex flex-wrap overflow-hidden rounded-full border border-line bg-white"
      >
        {CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            onClick={() => choose(choice)}
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
    </div>
  );
}
