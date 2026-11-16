import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ChevronDown, ListChecks } from 'lucide-react';
import { Link } from '@/i18n/navigation';

/**
 * Where the student is in the module, always in view.
 *
 * On the lesson page the progress bar and the programme used to live in the
 * side column, which on a phone falls BELOW the lesson — under the recording,
 * the documents and the text. So the one thing that says "lesson 3 of 12" was
 * the last thing on the page. This strip sits under the site header and stays
 * there: the way back to the module, the position, the bar, and on a phone a
 * "Programme" button that opens the same syllabus the wide layout shows.
 *
 * The drawer is a `<details>`: it opens before hydration and with JavaScript
 * off. The page keys this component by lesson, so moving to another lesson
 * closes it rather than leaving it open over the new one.
 */
export function CourseProgressStrip({
  courseHref,
  courseTitle,
  position,
  total,
  percent,
  children,
}: {
  courseHref: string;
  courseTitle: string;
  /** One-based position of the lesson on screen. */
  position: number;
  total: number;
  percent: number;
  /** The syllabus, shown in the drawer below `lg`. */
  children: ReactNode;
}) {
  const t = useTranslations('learn');

  return (
    <div className="sticky top-18 z-40 border-b border-line bg-white/95 backdrop-blur">
      <div className="shell relative flex items-center gap-3 py-2.5">
        <Link
          href={courseHref}
          className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-medium text-ink transition-colors hover:text-brand-600"
        >
          <ArrowLeft className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
          <span className="truncate">{courseTitle}</span>
        </Link>

        <span className="shrink-0 text-[12px] text-ink-muted tabular-nums">
          {t('lessonOf', { current: position, total })}
        </span>
        <span className="hidden shrink-0 text-[12px] font-medium text-brand-700 tabular-nums sm:inline">
          {percent}%
        </span>

        <details className="group shrink-0 lg:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-brand-300 [&::-webkit-details-marker]:hidden">
            <ListChecks className="size-3.5 text-ink-muted" aria-hidden="true" />
            {t('syllabusToggle')}
            <ChevronDown
              className="size-3.5 text-ink-muted transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="absolute inset-x-0 top-full max-h-[70dvh] overflow-y-auto border-b border-line bg-white px-5 py-5 shadow-lifted sm:px-6">
            {children}
          </div>
        </details>
      </div>

      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={courseTitle}
        className="h-1 bg-surface"
      >
        <span
          className="block h-full bg-brand-500 transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
