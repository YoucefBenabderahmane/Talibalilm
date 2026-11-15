'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { completeAndContinue, setLessonComplete, type ProgressState } from '@/app/actions/progress';

const EMPTY: ProgressState = { ok: false };

/**
 * The foot of a lesson: finish it and go on.
 *
 * It used to be two things that did not know about each other — a "mark as
 * finished" toggle, and further down a small "next lesson" link — so finishing
 * a lesson and reaching the next one were two decisions. Here the main button
 * does both, and what it says follows from where the student is:
 *
 *  - content on screen, not finished   → "Terminer et continuer" (one act)
 *  - already finished                  → "Leçon suivante", and a way to undo
 *  - nothing to read yet, or not theirs → the next lesson, without finishing
 *
 * Both writes are forms posting to server actions, so they work before
 * hydration and go through RLS like every other write.
 */
export function LessonActions({
  lessonId,
  slug,
  completed,
  hasContent,
  previousHref,
  nextHref,
  courseHref,
}: {
  lessonId: string;
  slug: string;
  completed: boolean;
  /** Whether the lesson's content is on screen — only then can it be finished. */
  hasContent: boolean;
  previousHref: string | null;
  /** Null on the module's last lesson. */
  nextHref: string | null;
  courseHref: string;
}) {
  const t = useTranslations('learn');
  const [advance, advanceAction, advancing] = useActionState(completeAndContinue, EMPTY);
  const [undo, undoAction, undoing] = useActionState(setLessonComplete, EMPTY);
  const failed = Boolean(advance.error || undo.error);

  return (
    <div className="mt-10 border-t border-line pt-6">
      {/* On a phone the main button comes first and takes the width: it is
          the one thing to do at the foot of a lesson. */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        {previousHref ? (
          <Button asChild variant="ghost" size="sm" className="self-start sm:self-auto">
            <Link href={previousHref}>
              <ArrowLeft aria-hidden="true" />
              {t('previous')}
            </Link>
          </Button>
        ) : (
          <span className="hidden sm:block" />
        )}

        {hasContent && !completed ? (
          <form action={advanceAction}>
            <input type="hidden" name="lessonId" value={lessonId} />
            <input type="hidden" name="slug" value={slug} />
            <Button
              type="submit"
              disabled={advancing}
              data-testid="finish-and-continue"
              className="w-full sm:w-auto"
            >
              {advancing ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 aria-hidden="true" />
              )}
              {nextHref ? t('finishAndContinue') : t('finishCourse')}
            </Button>
          </form>
        ) : nextHref ? (
          <Button asChild variant={completed ? 'primary' : 'outline'} className="w-full sm:w-auto">
            <Link href={nextHref}>
              {t('next')}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        ) : (
          <Button asChild variant={completed ? 'primary' : 'outline'} className="w-full sm:w-auto">
            <Link href={courseHref}>{t('backToCourse')}</Link>
          </Button>
        )}
      </div>

      {hasContent && completed && (
        <form
          action={undoAction}
          className="mt-4 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[12px]"
        >
          <input type="hidden" name="lessonId" value={lessonId} />
          <input type="hidden" name="completed" value="false" />
          <span className="inline-flex items-center gap-1.5 font-medium text-brand-700">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            {t('completed')}
          </span>
          <button
            type="submit"
            disabled={undoing}
            className="text-ink-muted underline decoration-line underline-offset-4 transition-colors hover:text-ink disabled:opacity-60"
          >
            {t('undoComplete')}
          </button>
        </form>
      )}

      {failed && (
        <p role="alert" className="mt-3 text-end text-[12px] text-red-600">
          {t('progressFailed')}
        </p>
      )}
    </div>
  );
}
