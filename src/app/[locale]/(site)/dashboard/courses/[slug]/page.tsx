import { Suspense } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { ArrowRight, CheckCircle2, Users } from 'lucide-react';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Syllabus } from '@/components/learn/Syllabus';
import { UpcomingClasses } from '@/components/live/UpcomingClasses';
import { PastClasses } from '@/components/live/PastClasses';
import { getCourse } from '@/lib/data/courses';
import { listClassesForStudent } from '@/lib/data/classes';
import { getCourseProgress, hasCourseAccess, listGroupLessonIds } from '@/lib/data/learning';
import { currentViewer, isStaff } from '@/lib/auth/guards';
import { supabaseConfigured } from '@/lib/env';
import { courseLessons } from '@/lib/content/types';
import { courseProgress, resumeLesson } from '@/lib/learn/path';
import { requireLocale } from '@/i18n/routing';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The module's home, for the student who holds it.
 *
 * There was none. A student went from the dashboard straight to lesson 1, and
 * the only page about "their" module was the public one that sells it. This is
 * the place a module is resumed from: how far they are, one button that opens
 * the next unfinished lesson, and the programme with each lesson's state —
 * finished, open now, or still to come for their group.
 *
 * It decides nothing about access. Whether the viewer holds the module is
 * `has_course_access`, asked of the database; somebody who does not is sent
 * to the public page, where the enrolment is. The programme's titles are
 * public already — they are the sales page — and every lesson link still
 * leads to a page whose content is an RLS-gated read.
 */
export default async function CourseHomePage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  if (!supabaseConfigured) redirect('/login');

  const viewer = await currentViewer();
  if (!viewer) redirect('/login');

  const course = await getCourse(slug);
  if (!course) notFound();

  const lessons = courseLessons(course);
  const lessonIds = lessons.map((lesson) => lesson.id);
  const staff = isStaff(viewer);

  // Everything the page needs, in one wave. The group's lessons need no class
  // id — RLS returns the student's own group's rows — so they do not wait for
  // the read that finds the group.
  const [hasAccess, groups, progress, groupLessonIds] = await Promise.all([
    hasCourseAccess(course.id),
    staff ? Promise.resolve(null) : listClassesForStudent(course.id, viewer.id),
    getCourseProgress(lessonIds),
    staff ? Promise.resolve(null) : listGroupLessonIds(lessonIds),
  ]);

  // Not theirs: the public page is where a module is chosen and paid for.
  if (!hasAccess && !staff) {
    return localeRedirect({ href: `/courses/${course.slug}`, locale });
  }

  const t = await getTranslations('learn');
  const tCourses = await getTranslations('courses');

  const myClass = groups?.classes.find((group) => group.id === groups.myClassId) ?? null;
  // A module whose content is per group, and a holder who has not entered one.
  const needsClass = !staff && groups !== null && groups.classes.length > 0 && myClass === null;
  const availableIds = myClass ? groupLessonIds : null;

  const overall = courseProgress(lessons, progress);
  const resume = resumeLesson(lessons, progress);
  const resumeHref = resume ? `/dashboard/courses/${course.slug}/lessons/${resume.id}` : null;
  const resumeLabel = overall.complete
    ? t('review')
    : overall.done > 0
      ? t('continue')
      : t('start');

  return (
    <>
      <section className="hero-wash border-b border-line">
        <div className="shell py-8 sm:py-10">
          <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
            <Link
              href="/dashboard"
              className="text-ink-muted transition-colors hover:text-brand-600"
            >
              {t('breadcrumb')}
            </Link>
            <span aria-hidden="true" className="text-ink-muted/60">
              /
            </span>
            <span className="text-ink">{course.title}</span>
          </nav>

          <Badge variant="soft">{tCourses(`category.${course.category}`)}</Badge>
          <h1 className="mt-3 font-display text-[clamp(1.5rem,3.4vw,2.125rem)] leading-tight font-semibold text-ink">
            {course.title}
          </h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
            {t('courseHomeLead')}
          </p>

          <div className="mt-6 max-w-2xl rounded-[var(--radius-card)] border border-line bg-white p-5 shadow-card sm:p-6">
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="text-ink-muted">
                {t('progress', { done: overall.done, total: overall.total })}
              </span>
              <span className="font-display text-lg font-semibold text-brand-700 tabular-nums">
                {overall.percent}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={overall.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={course.title}
              className="mt-2 h-2.5 overflow-hidden rounded-full bg-surface"
            >
              <span
                className="block h-full rounded-full bg-brand-500 transition-[width] duration-500"
                style={{ width: `${overall.percent}%` }}
              />
            </div>

            {overall.complete && (
              <div className="mt-5 flex items-start gap-3 rounded-[var(--radius-input)] bg-brand-50 p-4">
                <CheckCircle2
                  className="mt-0.5 size-5 shrink-0 text-brand-600"
                  aria-hidden="true"
                />
                <div>
                  <p className="font-display text-[15px] font-semibold text-brand-700">
                    {t('courseDoneTitle')}
                  </p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-brand-700/80">
                    {t('courseDoneBody')}
                  </p>
                </div>
              </div>
            )}

            {resume && resumeHref && !needsClass && (
              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
                <Button asChild size="lg" variant={overall.complete ? 'outline' : 'primary'}>
                  <Link href={resumeHref} data-testid="resume-course">
                    {resumeLabel}
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
                {!overall.complete && (
                  <p className="min-w-0 flex-1 text-[13px] text-ink-muted">
                    {t('nextUp', { title: resume.title })}
                  </p>
                )}
              </div>
            )}

            {lessons.length === 0 && (
              <p className="mt-5 text-[13px] text-ink-muted">{t('courseEmpty')}</p>
            )}
          </div>
        </div>
      </section>

      <section className="py-10 sm:py-12">
        <div className="shell grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            {/* The content of this module is each group's own, so a holder with
                no group has nothing to open yet. Said here, once, rather than
                on every lesson they try. */}
            {needsClass && (
              <div className="mb-8 rounded-[var(--radius-card)] border border-gold-300 bg-gold-50/60 p-5">
                <p className="font-display text-[15px] font-semibold text-ink">
                  {t('classRequiredTitle')}
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                  {t('classRequiredBody')}
                </p>
                <Button asChild className="mt-4" variant="gold">
                  <Link href={`/courses/${course.slug}#classe`}>{t('classRequiredCta')}</Link>
                </Button>
              </div>
            )}

            <h2 className="font-display text-xl font-semibold text-ink">
              {tCourses('detail.syllabus')}
            </h2>
            <div className="mt-5 rounded-[var(--radius-card)] border border-line bg-white p-4 sm:p-6">
              <Syllabus
                course={course}
                progress={progress}
                hasAccess
                availableIds={availableIds}
                size="comfortable"
              />
            </div>
          </div>

          <aside className="space-y-4">
            {myClass && (
              <div className="rounded-[var(--radius-card)] border border-line bg-white p-5">
                <div className="flex items-center gap-2">
                  <Users className="size-4 text-brand-500" aria-hidden="true" />
                  <h2 className="font-display text-[15px] font-semibold text-ink">
                    {t('myClass')}
                  </h2>
                </div>
                <p className="mt-3 text-[14px] font-medium text-ink">{myClass.name}</p>
                {myClass.schedule && (
                  <p className="mt-0.5 text-[12px] whitespace-pre-line text-ink-muted">
                    {myClass.schedule}
                  </p>
                )}
                {myClass.currentLessonTitle && (
                  <p className="mt-2 text-[12px] text-ink-muted">
                    {tCourses('detail.classCurrentLesson', { lesson: myClass.currentLessonTitle })}
                  </p>
                )}
                <Link
                  href={`/courses/${course.slug}#classe`}
                  className="mt-3 inline-block text-[12px] text-ink-muted underline decoration-line underline-offset-4 transition-colors hover:text-brand-600"
                >
                  {t('changeClass')}
                </Link>
              </div>
            )}

            {/* The group's live classes for this module. Streamed: two reads
                the programme need not wait for. Renders nothing when there
                are none. */}
            <div className="empty:hidden">
              <Suspense fallback={null}>
                <UpcomingClasses locale={locale} courseId={course.id} limit={3} />
              </Suspense>
            </div>

            {/* Every class this module's group has held, with the student's
                attendance at each. The dashboard shows the last few. */}
            {!staff && (
              <div className="empty:hidden">
                <Suspense fallback={null}>
                  <PastClasses locale={locale} userId={viewer.id} courseId={course.id} limit={50} />
                </Suspense>
              </div>
            )}
          </aside>
        </div>
      </section>
    </>
  );
}
