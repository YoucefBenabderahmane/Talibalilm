import { useTranslations } from 'next-intl';
import { CheckCircle2, Clock, Lock, PlayCircle } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import type { Course } from '@/lib/content/types';
import { isCompleted, lessonState, type LessonState, type ProgressMap } from '@/lib/learn/path';
import { cn } from '@/lib/utils';

/**
 * The module's programme, as a route: what is finished, where the student is,
 * what can be opened now and what is still to come for their group.
 *
 * One component for the lesson page's side column, the drawer that replaces
 * it on a phone, and the module's home — so the three cannot describe the
 * same module differently. It renders links and nothing that decides access:
 * a lesson shown as "à venir" or locked is still a link, and what the student
 * finds behind it is whatever the RLS-gated read returns.
 */
export function Syllabus({
  course,
  progress,
  currentId,
  hasAccess,
  availableIds,
  size = 'compact',
}: {
  course: Pick<Course, 'slug' | 'modules'>;
  progress: ProgressMap;
  /** The lesson on screen, on the lesson page. */
  currentId?: string;
  hasAccess: boolean;
  /** Lessons with content for the viewer's group; null when not known. */
  availableIds: ReadonlySet<string> | null;
  /** `compact` for the side column, `comfortable` for the module's home. */
  size?: 'compact' | 'comfortable';
}) {
  const t = useTranslations('learn');
  const tCourses = useTranslations('courses');
  const roomy = size === 'comfortable';

  const modules = course.modules
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((module) => ({
      ...module,
      lessons: module.lessons.slice().sort((a, b) => a.position - b.position),
    }));

  return (
    <ol className={roomy ? 'space-y-6' : 'space-y-4'}>
      {modules.map((module) => {
        const finished = module.lessons.filter((l) => isCompleted(progress.get(l.id))).length;
        return (
          <li key={module.id}>
            <div className="flex items-baseline justify-between gap-3">
              <p
                className={cn(
                  'tracking-[0.1em] text-ink-muted uppercase',
                  roomy ? 'text-[12px]' : 'text-[11px]',
                )}
              >
                {module.title}
              </p>
              {module.lessons.length > 0 && (
                <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">
                  {t('moduleCount', {
                    done: finished,
                    total: module.lessons.length,
                  })}
                </span>
              )}
            </div>

            <ul className={cn('mt-2', roomy ? 'space-y-1' : 'space-y-0.5')}>
              {module.lessons.map((lesson) => {
                const state = lessonState({
                  lesson,
                  progress,
                  currentId,
                  hasAccess,
                  availableIds,
                });
                // The page being read keeps its tick once it is finished: the
                // highlight says "you are here", the icon says "and it is done".
                const finishedHere = isCompleted(progress.get(lesson.id));
                const minutes = Math.round(lesson.duration_seconds / 60);
                return (
                  <li key={lesson.id}>
                    <Link
                      href={`/dashboard/courses/${course.slug}/lessons/${lesson.id}`}
                      aria-current={state === 'current' ? 'page' : undefined}
                      data-state={state}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg transition-colors',
                        roomy ? 'px-3 py-2.5 text-[14px]' : 'px-2 py-1.5 text-[12px]',
                        state === 'current'
                          ? 'bg-brand-50 font-medium text-brand-700'
                          : state === 'upcoming' || state === 'locked'
                            ? 'text-ink-muted/70 hover:bg-surface hover:text-ink-muted'
                            : 'text-ink-muted hover:bg-surface hover:text-ink',
                      )}
                    >
                      <StateIcon state={finishedHere ? 'done' : state} roomy={roomy} />
                      <span className={cn('flex-1', roomy ? 'line-clamp-2' : 'line-clamp-1')}>
                        {lesson.title}
                      </span>
                      {state === 'upcoming' && (
                        <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[10px] text-ink-muted">
                          {t('stateUpcoming')}
                        </span>
                      )}
                      {state !== 'upcoming' && minutes > 0 && (
                        <span className="shrink-0 text-[11px] text-ink-muted/80 tabular-nums">
                          {tCourses('minutes', { count: minutes })}
                        </span>
                      )}
                      {/* The "à venir" tag above is read aloud already; the
                          other states are icons only, so they are named here. */}
                      {state !== 'upcoming' && (
                        <span className="sr-only">
                          {t(STATE_LABEL[finishedHere ? 'done' : state])}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

const STATE_LABEL = {
  done: 'stateDone',
  current: 'stateCurrent',
  available: 'stateAvailable',
  upcoming: 'stateUpcoming',
  locked: 'stateLocked',
} as const satisfies Record<LessonState, string>;

function StateIcon({ state, roomy }: { state: LessonState; roomy: boolean }) {
  const size = roomy ? 'size-4' : 'size-3.5';
  if (state === 'done') {
    return <CheckCircle2 className={cn(size, 'shrink-0 text-brand-500')} aria-hidden="true" />;
  }
  if (state === 'current') {
    return <PlayCircle className={cn(size, 'shrink-0 text-brand-600')} aria-hidden="true" />;
  }
  if (state === 'upcoming') {
    return <Clock className={cn(size, 'shrink-0 text-ink-muted/50')} aria-hidden="true" />;
  }
  if (state === 'locked') {
    return <Lock className={cn(size, 'shrink-0 text-ink-muted/50')} aria-hidden="true" />;
  }
  return <PlayCircle className={cn(size, 'shrink-0 text-ink-muted/60')} aria-hidden="true" />;
}
