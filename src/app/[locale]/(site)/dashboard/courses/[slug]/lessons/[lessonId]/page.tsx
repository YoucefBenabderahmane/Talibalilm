import { Suspense } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { signDownload } from '@/lib/storage/r2';
import { notFound, redirect } from 'next/navigation';
import { after } from 'next/server';
import type { Metadata } from 'next';
import { ExternalLink, FileText, Lock, Users } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CourseProgressStrip } from '@/components/learn/CourseProgressStrip';
import { LessonActions } from '@/components/learn/LessonActions';
import { LessonVideo } from '@/components/learn/LessonVideo';
import { Syllabus } from '@/components/learn/Syllabus';
import { getCourse } from '@/lib/data/courses';
import {
  getClassLessonContent,
  getCourseProgress,
  getLessonContent,
  getViewerClassId,
  hasCourseAccess,
  listGroupLessonIds,
  touchEnrollment,
} from '@/lib/data/learning';
import { courseProgress, isCompleted, neighbours } from '@/lib/learn/path';
import { currentViewer, isStaff } from '@/lib/auth/guards';
import { supabaseConfigured } from '@/lib/env';
import { courseLessons } from '@/lib/content/types';
import { embedUrl, type VideoProvider } from '@/lib/content/video';
import { formatBytes } from '@/lib/media/video';
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

  const viewer = await currentViewer();
  if (!viewer) redirect('/login');

  const course = await getCourse(slug);
  if (!course) notFound();

  const lessons = courseLessons(course);
  const lesson = lessons.find((l) => l.id === lessonId);
  if (!lesson) notFound();

  const t = await getTranslations('learn');
  const tCourses = await getTranslations('courses');

  const staff = isStaff(viewer);

  // Three reads that do not depend on one another, in flight together: this
  // page used to await nine round trips one after the other, and the
  // teacher's "every click waits" was mostly that. `hasAccess` is only for the
  // padlock icons in the sidebar — access to THIS lesson is decided by which
  // content comes back below, not by this flag. The class lookup reads the
  // viewer's own membership rows and nothing else, so asking before knowing
  // whether they hold the course costs nothing it should not.
  //
  // The fourth is which lessons the student's group has been given — what lets
  // the syllabus say "à venir" instead of leaving them to click and find out.
  // RLS returns their own group's rows, so it needs no class id and can leave
  // with the others.
  const lessonIds = lessons.map((l) => l.id);
  const [hasAccess, ownClassId, progress, groupLessonIds] = await Promise.all([
    hasCourseAccess(course.id),
    staff ? Promise.resolve(null) : getViewerClassId(course.id, viewer.id),
    getCourseProgress(lessonIds),
    staff ? Promise.resolve(null) : listGroupLessonIds(lessonIds),
  ]);

  // Content is per group now. A holder reads their own class's row and nothing
  // else; a visitor reads the shared row of a public preview; staff read the
  // shared row (the admin edits class content from the module screen). A
  // holder with no group yet is asked to enter one rather than shown another
  // group's material.
  const myClassId = hasAccess && !staff ? ownClassId : null;
  const needsClass = hasAccess && !staff && myClassId === null;

  const content = staff
    ? await getLessonContent(lesson.id)
    : myClassId
      ? await getClassLessonContent(lesson.id, myClassId)
      : lesson.is_preview
        ? await getLessonContent(lesson.id)
        : null;

  // Known only for a holder who sits in a group. For anyone else the syllabus
  // claims nothing rather than calling every lesson "à venir".
  const availableIds = myClassId ? groupLessonIds : null;

  // A short-lived signature for an uploaded video, minted only once the read
  // above has succeeded — that read is RLS-gated, so it IS the paywall. The
  // bucket stays private: there is no public base URL anywhere in this app.
  //
  // Six hours, not one: the player keeps asking the bucket for the next part of
  // the file as it plays, so a signature that runs out mid-lesson stopped a
  // two-hour recording partway through. Six covers the longest class with
  // pauses; a link that escapes still dies the same day.
  const videoSrc =
    content?.videoProvider === 'r2' && content.videoId
      ? await signDownload(content.videoId, 6 * 3600)
      : null;

  // The group's support documents, each signed only after the RLS-gated read
  // above let the row through — the same posture as the video. A document the
  // bucket will not sign stays in the list without a link rather than
  // disappearing, so the student knows it exists.
  const documents = content
    ? await Promise.all(
        content.documents.map(async (document) => ({
          ...document,
          url: await signDownload(document.key, 3600),
        })),
      )
    : [];

  // The visit is noted after the response has gone out, not before: a write
  // the student never sees must not be a round trip the page waits for.
  if (hasAccess) {
    after(() => touchEnrollment(course.id, viewer.id));
  }

  const done = isCompleted(progress.get(lesson.id));
  const overall = courseProgress(lessons, progress);
  const { index, previous, next } = neighbours(lessons, lesson.id);

  const courseHref = `/dashboard/courses/${course.slug}`;
  const lessonHref = (id: string) => `/dashboard/courses/${course.slug}/lessons/${id}`;

  // One syllabus, rendered twice: in the side column on a wide screen and in
  // the strip's drawer on a phone, where the side column falls below the
  // whole lesson.
  const syllabus = (
    <Syllabus
      course={course}
      progress={progress}
      currentId={lesson.id}
      hasAccess={hasAccess || staff}
      availableIds={availableIds}
    />
  );

  return (
    <>
      {/* Keyed by lesson so the drawer closes when the student moves on. */}
      <CourseProgressStrip
        key={lesson.id}
        courseHref={courseHref}
        courseTitle={course.title}
        position={index + 1}
        total={lessons.length}
        percent={overall.percent}
      >
        {syllabus}
      </CourseProgressStrip>

      <div className="shell grid gap-10 py-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:py-12">
        <article className="min-w-0">
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
            <Link
              href={courseHref}
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
                    // Remembers the student's place in the recording and marks
                    // the lesson finished when it has played to the end.
                    <LessonVideo
                      key={lesson.id}
                      src={videoSrc}
                      lessonId={lesson.id}
                      startAt={progress.get(lesson.id)?.seconds_watched ?? 0}
                      completed={done}
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

              {/* The written support, under the recording it belongs to. A card,
                not an embedded viewer: Safari on iOS refuses inline PDFs, and a
                blank frame where the lesson should be is worse than a link that
                opens the document in its own tab. */}
              {documents.length > 0 && (
                <section className="mt-6 rounded-[var(--radius-card)] border border-line bg-white p-4">
                  <p className="eyebrow">{t('pdfSupport')}</p>
                  <ul className="mt-3 space-y-2">
                    {documents.map((document) => (
                      <li
                        key={document.key}
                        className="flex flex-wrap items-center gap-2 rounded-[var(--radius-input)] border border-line bg-surface/40 px-3 py-2.5"
                      >
                        <FileText className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                          {document.filename}
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-muted">
                          {formatBytes(document.bytes)}
                        </span>
                        {document.url ? (
                          <Button asChild size="sm" variant="outline">
                            <a href={document.url} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="size-3.5" aria-hidden="true" />
                              {t('pdfOpen')}
                            </a>
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <div className="mt-6 text-[15px] leading-relaxed whitespace-pre-line text-ink-soft">
                {content.content || t('noBody')}
              </div>
            </>
          ) : needsClass ? (
            <div className="mt-6 rounded-[var(--radius-card)] border border-line bg-surface/60 p-8 text-center">
              <span
                className="mx-auto flex size-11 items-center justify-center rounded-full bg-white text-ink-muted"
                aria-hidden="true"
              >
                <Users className="size-5" />
              </span>
              <h2 className="mt-4 font-display text-lg font-semibold text-ink">
                {t('classRequiredTitle')}
              </h2>
              <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-ink-muted">
                {t('classRequiredBody')}
              </p>
              <Button asChild className="mt-6">
                <Link href={`/courses/${course.slug}#classe`}>{t('classRequiredCta')}</Link>
              </Button>
            </div>
          ) : hasAccess ? (
            // The group is known and the lesson is theirs, but the office has not
            // put this lesson's text or recording in place yet.
            <div className="mt-6 rounded-[var(--radius-card)] border border-dashed border-line bg-surface/60 p-8 text-center">
              <h2 className="font-display text-lg font-semibold text-ink">{t('pendingTitle')}</h2>
              <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-ink-muted">
                {t('pendingBody')}
              </p>
            </div>
          ) : (
            <div className="mt-6 rounded-[var(--radius-card)] border border-line bg-surface/60 p-8 text-center">
              <span
                className="mx-auto flex size-11 items-center justify-center rounded-full bg-white text-ink-muted"
                aria-hidden="true"
              >
                <Lock className="size-5" />
              </span>
              <h2 className="mt-4 font-display text-lg font-semibold text-ink">
                {t('lockedTitle')}
              </h2>
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

          {/* Finish and go on, in one act. A lesson can only be finished when
            its content is on screen; a visitor on a free preview holds no
            progress to write, so they are simply offered the next lesson. */}
          <LessonActions
            key={lesson.id}
            lessonId={lesson.id}
            slug={course.slug}
            completed={done}
            hasContent={content !== null && (hasAccess || staff)}
            previousHref={previous ? lessonHref(previous.id) : null}
            nextHref={next ? lessonHref(next.id) : null}
            courseHref={courseHref}
          />
        </article>

        <aside className="lg:sticky lg:top-36 lg:self-start">
          {/* A class opening now is the most time-sensitive thing on this page,
            so it sits above the syllabus. Renders nothing when there is none —
            and nothing at all for a course the viewer does not hold, because
            the query behind it reads through RLS. */}
          {/* Streamed: its two reads arrive after the lesson has painted rather
            than holding the whole page back for them. */}
          <div className="mb-6 empty:mb-0">
            <Suspense fallback={null}>
              <UpcomingClasses locale={locale} courseId={course.id} limit={3} />
            </Suspense>
          </div>

          {/* The wide layout's syllabus. Below `lg` the strip's drawer carries it,
            so it is not repeated under the whole lesson on a phone. */}
          <div className="hidden rounded-[var(--radius-card)] border border-line bg-white p-5 lg:block">
            <p className="eyebrow">{tCourses('detail.syllabus')}</p>
            <h2 className="mt-2 font-display text-[15px] leading-snug font-semibold text-ink">
              {course.title}
            </h2>
            <p className="mt-2 text-[11px] text-ink-muted">
              {t('progress', { done: overall.done, total: overall.total })}
            </p>
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface"
              role="progressbar"
              aria-valuenow={overall.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={course.title}
            >
              <span
                className="block h-full rounded-full bg-brand-500 transition-all"
                style={{ width: `${overall.percent}%` }}
              />
            </div>

            <div className="mt-5">{syllabus}</div>
          </div>
        </aside>
      </div>
    </>
  );
}
