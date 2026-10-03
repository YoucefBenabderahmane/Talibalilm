'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { joinClass, leaveClass } from '@/app/actions/classes';
import { cn } from '@/lib/utils';
import type { StudentClass } from '@/lib/data/classes';

/** Action keys are mapped here, so a stray string cannot reach a student. */
const MESSAGE: Record<string, 'classNotAllowed' | 'classSaveFailed' | 'classUnavailable'> = {
  notAllowed: 'classNotAllowed',
  saveFailed: 'classSaveFailed',
  unavailable: 'classUnavailable',
};

/**
 * The student's own group, on the module they hold.
 *
 * They choose it themselves — the office names the groups and can take someone
 * out, but never has to place anybody. One class per module is a database
 * constraint, so choosing another moves them: the action leaves the old class
 * and joins the new one, both as the student.
 *
 * Until they are in a class, the module's live sessions are not theirs to see
 * (`live_sessions` is class-scoped now), which is why this is not hidden behind
 * a menu: it is the step that opens the classroom.
 */
export function ClassPicker({
  classes,
  myClassId,
}: {
  classes: StudentClass[];
  myClassId: string | null;
}) {
  const t = useTranslations('courses');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (call: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await call();
      if (!result.ok) {
        setError(t(`detail.${MESSAGE[result.error ?? 'saveFailed']}`));
      }
    });
  };

  return (
    <div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {classes.map((klass) => {
          const mine = klass.id === myClassId;
          return (
            <li key={klass.id}>
              <button
                type="button"
                aria-pressed={mine}
                disabled={pending || mine}
                onClick={() => run(() => joinClass(klass.id))}
                className={cn(
                  'flex w-full flex-col items-start rounded-[var(--radius-card)] border p-4 text-start transition-colors',
                  mine
                    ? 'border-brand-400 bg-brand-50/60'
                    : 'border-line bg-white hover:border-brand-300 disabled:opacity-60',
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="font-display text-[15px] font-semibold text-ink">
                    {klass.name}
                  </span>
                  {mine && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-700">
                      <Check className="size-3.5" aria-hidden="true" />
                      {t('detail.classMine')}
                    </span>
                  )}
                </span>
                {klass.schedule && (
                  <span className="mt-1 text-[12px] text-ink-muted">{klass.schedule}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {myClassId && (
        <div className="mt-4">
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => leaveClass(myClassId))}
            className="text-[12px] text-ink-muted underline underline-offset-4 transition-colors hover:text-ink disabled:opacity-60"
          >
            {t('detail.classLeave')}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[12px] text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
