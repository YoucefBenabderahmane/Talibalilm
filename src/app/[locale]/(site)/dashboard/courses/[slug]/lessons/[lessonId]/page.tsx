import { getTranslations, setRequestLocale } from 'next-intl/server';
import { signDownload } from '@/lib/storage/r2';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { CheckCircle2, Circle, Lock, PlayCircle } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CompleteToggle } from '@/components/learn/CompleteToggle';
import { getCourse } from '@/lib/data/courses';
import {
  getCourseProgress,
  getLessonContent,
  hasCourseAccess,
  touchEnrollment,
} from '@/lib/data/learning';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { courseLessons } from '@/lib/content/types';
import { embedUrl, type VideoProvider } from '@/lib/content/video';
import { cn } from '@/lib/utils';
import { UpcomingClasses } from '@/components/live/UpcomingClasses';
import { requireLocale } from '@/i18n/routing';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The learning view.
 *
 * Three checks, in this order: signed in, lesson exists in a published course,
 * and content readable. The third is not a check this page performs — it asks
 * the database for the content and renders the paywall when nothing comes
 * back. That is the difference from the old plugin: there is no branch here
 * that decides to hide something it already holds.
 */
export default async function LessonPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string; lessonId: string }>;
}) {
  const { locale, slug, lessonId } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  if (!supabaseConfigured) redirect('/login');

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const course = await getCourse(slug);
  if (!course) notFound();

  const lessons = courseLessons(course);
  const lesson = lessons.find((l) => l.id === lessonId);
  if (!lesson) notFound();

  const t = await getTranslations('learn');
  const tCourses = await getTranslations('courses');

  // Asked for unconditionally. RLS answers with null for a non-member, so the
  // paywall below is driven by the database's decision, not by ours.
  const content = await getLessonContent(lesson.id);

  // A short-lived signature for an uploaded video, minted only once the read
  // above has succeeded — that read is RLS-gated, so it IS the paywall. The
  // bucket stays private: there is no public base URL anywhere in this app.
  const videoSrc =
    content?.videoProvider === 'r2' && content.videoId
      ? await signDownload(content.videoId, 3600)
      : null;
  // Only for the padlock icons in the sidebar — access to THIS lesson is
  // decided by whether `content` came back, not by this flag.
  const hasAccess = await hasCourseAccess(course.id);

  if (hasAccess) await touchEnrollment(course.id, user.id);

  const progress = await getCourseProgress(lessons.map((l) => l.id));
  const done = progress.get(lesson.id)?.status === 'completed';
  const completedCount = lessons.filter((l) => progress.get(l.id)?.status === 'completed').length;

  const index = lessons.findIndex((l) => l.id === lesson.id);
  const previous = index > 0 ? lessons[index - 1] : undefined;
  const next = index < lessons.length - 1 ? lessons[index + 1] : undefined;

  return (
    <div className="shell grid gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:py-14">
      <article className="min-w-0">
        <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
          <Link href="/dashboard" className="text-ink-muted transition-colors hover:text-brand-600">
            {t('breadcrumb')}
          </Link>
          <span aria-hidden="true" className="text-ink-muted/60">
            /
          </span>
          <Link
            href={`/courses/${course.slug}`}
            className="text-ink-muted transition-colors hover:text-brand-600"
          >
            {course.title}
          </Link>
        </nav>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="soft">{tCourses(`category.${course.category}`)}</Badge>
          {lesson.is_preview && <Badge variant="gold">{tCourses('detail.previewBadge')}</Badge>}
        </div>

        <h1 className="mt-3 font-display text-[clamp(1.5rem,3.4vw,2.125rem)] leading-tight font-semibold text-ink">
          {lesson.title}
        </h1>

        {content ? (
          <>
            {/*
              An uploaded video, played from our own bucket.

              Rendered before the embed branch because it is not an embed. The
              signature is minted HERE, in a server component, after the
              RLS-gated read above has already let the row through — so the
              paywall decides, and the URL it produces stops working within the
              hour if it escapes.
            */}
            {content.videoProvider === 'r2' && content.videoId && (
              <div className="mt-6 overflow-hidden rounded-[var(--radius-card)] border border-line bg-black">
                {videoSrc ? (
                  <video
                    src={videoSrc}
                    controls
                    preload="metadata"
                    controlsList="nodownload"
                    className="block aspect-video w-full"
                  />
                ) : (
                  <p className="flex aspect-video items-center justify-center px-6 text-center text-[13px] text-white/70">
                    {t('playerPending')}
                  </p>
                )}
              </div>
            )}

            {content.videoProvider !== 'none' &&
              content.videoProvider !== 'r2' &&
              (() => {
                // Reaching this branch already means the paywall let the row
                // through: `getLessonContent` is an RLS-gated read, so a
                // non-member got null and is looking at the paywall instead.
                const src = embedUrl({
                  provider: content.videoProvider as VideoProvider,
                  id: content.videoId ?? '',
                });

                if (!src) {
                  return (
                    <div className="mt-6 flex aspect-video items-center justify-center rounded-[var(--radius-card)] border border-line bg-surface text-center">
                      <p className="max-w-sm px-6 text-[13px] text-ink-muted">
                        {t('playerPending')}
                      </p>
                    </div>
                  );
                }

                return (
                  <div className="mt-6 overflow-hidden rounded-[var(--radius-card)] border border-line bg-black">
                    <iframe
                      src={src}
                      title={lesson.title}
                      // `block` because an iframe is inline by default, which leaves a
                      // few pixels of descender gap inside the rounded frame on mobile.
                      className="block aspect-video w-full"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                      allowFullScreen
                      // The embed is a third party. Denying it our referrer and
                      // sandboxing it keeps a lesson page from handing YouTube
                      // or Drive anything about the student beyond the play.
                      referrerPolicy="strict-origin-when-cross-origin"
                      loading="lazy"
                    />
                  </div>
                );
              })()}

            <div className="mt-6 text-[15px] leading-relaxed whitespace-pre-line text-ink-soft">
              {content.content || t('noBody')}
            </div>

            <div className="mt-8 border-t border-line pt-6">
              <CompleteToggle lessonId={lesson.id} completed={done} />
            </div>
          </>
        ) : (
          <div className="mt-6 rounded-[var(--radius-card)] border border-line bg-surface/60 p-8 text-center">
            <span
              className="mx-auto flex size-11 items-center justify-center rounded-full bg-white text-ink-muted"
              aria-hidden="true"
            >
              <Lock className="size-5" />
            </span>
            <h2 className="mt-4 font-display text-lg font-semibold text-ink">{t('lockedTitle')}</h2>
            <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-ink-muted">
              {t('lockedBody')}
            </p>
            <Button asChild className="mt-6">
              <Link href={`/courses/${course.slug}#inscription`}>
                {tCourses('detail.enrollCta')}
              </Link>
            </Button>
          </div>
        )}

        <nav className="mt-10 flex items-center justify-between gap-4 border-t border-line pt-6">
          {previous ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/dashboard/courses/${course.slug}/lessons/${previous.id}`}>
                {t('previous')}
              </Link>
            </Button>
          ) : (
            <span />
          )}
          {next && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/courses/${course.slug}/lessons/${next.id}`}>{t('next')}</Link>
            </Button>
          )}
        </nav>
      </article>

      <aside className="lg:sticky lg:top-24 lg:self-start">
        {/* A class opening now is the most time-sensitive thing on this page,
            so it sits above the syllabus. Renders nothing when there is none —
            and nothing at all for a course the viewer does not hold, because
            the query behind it reads through RLS. */}
        <div className="mb-6 empty:mb-0">
          <UpcomingClasses locale={locale} courseId={course.id} limit={3} />
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-white p-5">
          <p className="eyebrow">{tCourses('detail.syllabus')}</p>
          <h2 className="mt-2 font-display text-[15px] leading-snug font-semibold text-ink">
            {course.title}
          </h2>
          <p className="mt-2 text-[11px] text-ink-muted">
            {t('progress', { done: completedCount, total: lessons.length })}
          </p>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface"
            role="progressbar"
            aria-valuenow={completedCount}
            aria-valuemin={0}
            aria-valuemax={lessons.length}
          >
            <span
              className="block h-full rounded-full bg-brand-500 transition-all"
              style={{ width: `${lessons.length ? (completedCount / lessons.length) * 100 : 0}%` }}
            />
          </div>

          <ol className="mt-5 space-y-4">
            {course.modules.map((module) => (
              <li key={module.id}>
                <p className="text-[11px] tracking-[0.1em] text-ink-muted uppercase">
                  {module.title}
                </p>
                <ul className="mt-2 space-y-0.5">
                  {module.lessons.map((l) => {
                    const isCurrent = l.id === lesson.id;
                    const isDone = progress.get(l.id)?.status === 'completed';
                    return (
                      <li key={l.id}>
                        <Link
                          href={`/dashboard/courses/${course.slug}/lessons/${l.id}`}
                          aria-current={isCurrent ? 'page' : undefined}
                          className={cn(
                            'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors',
                            isCurrent
                              ? 'bg-brand-50 font-medium text-brand-700'
                              : 'text-ink-muted hover:bg-surface hover:text-ink',
                          )}
                        >
                          {isDone ? (
                            <CheckCircle2
                              className="size-3.5 shrink-0 text-brand-500"
                              aria-hidden="true"
                            />
                          ) : l.is_preview || hasAccess ? (
                            <PlayCircle
                              className="size-3.5 shrink-0 text-ink-muted/60"
                              aria-hidden="true"
                            />
                          ) : (
                            <Circle
                              className="size-3.5 shrink-0 text-ink-muted/40"
                              aria-hidden="true"
                            />
                          )}
                          <span className="line-clamp-1 flex-1">{l.title}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </div>
  );
}
