import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { CourseSettingsForm } from '@/components/admin/CourseSettingsForm';
import { CoverUpload } from '@/components/admin/CoverUpload';
import { GalleryUpload } from '@/components/admin/GalleryUpload';
import { readBullets, readGallery, readHighlights } from '@/lib/content/presentation';
import { readDocuments } from '@/lib/content/lesson-files';
import { CourseOutline, type OutlineClassContent } from '@/components/admin/CourseOutline';
import { PublishControls } from '@/components/admin/PublishControls';
import { CourseSteps } from '@/components/admin/CourseSteps';
import { CourseFees, type CourseFee } from '@/components/admin/CourseFees';
import { ClassManager } from '@/components/admin/ClassManager';
import { listClassesWithMembers } from '@/lib/data/classes';
import { createClient } from '@/lib/supabase/server';
import { reportError } from '@/lib/observability/report';
import { requireLocale } from '@/i18n/routing';

/**
 * The course builder — the screen the school lives in.
 *
 * Staff read draft courses and lesson content through the `is_staff()`
 * policies, so this page needs no special client: the same anon key that
 * refuses a student answers fully for an instructor.
 */
export default async function CourseBuilderPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  const t = await getTranslations('admin');
  const supabase = await createClient();

  const { data: course, error: courseError } = await supabase
    .from('courses')
    .select(
      `id, slug, title, subtitle, description, title_ar, category, level, format, tone,
       schedule, duration_weeks, status, published_at, cover_url,
       department, department_body, requirements, highlights, gallery,
       modules ( id, title, position,
         lessons ( id, title, slug, type, position, duration_seconds, is_preview ) )`,
    )
    .eq('id', id)
    .maybeSingle();

  // A refused query and a course that does not exist are NOT the same thing,
  // and treating them alike is what turned "PostgREST cannot see this column
  // yet" into a blank error page. A select naming a column the API has not
  // reloaded fails whole; the row is there and perfectly readable by hand.
  // Staff get the database's own words, which name the fix.
  if (courseError) {
    reportError('admin.course.load', courseError, { id });
    return (
      <div className="max-w-2xl">
        <Link
          href="/admin/courses"
          className="inline-flex items-center gap-2 text-xs text-ink-muted transition-colors hover:text-brand-600"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          {t('backToCourses')}
        </Link>
        <div className="mt-6 rounded-[var(--radius-card)] border border-red-200 bg-red-50/50 p-5">
          <p className="text-[13px] font-medium text-red-700">{t('courseLoadFailed')}</p>
          <p className="mt-2 font-mono text-[12px] break-words text-red-700">
            {`${courseError.code ?? ''} ${courseError.message}`.trim()}
          </p>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">{t('courseLoadHint')}</p>
        </div>
      </div>
    );
  }

  if (!course) notFound();

  // Content is fetched separately rather than joined: it is the gated table,
  // and keeping the query distinct makes it obvious which read needs staff
  // rights and which does not.
  const lessonIds = (course.modules ?? []).flatMap((m) => (m.lessons ?? []).map((l) => l.id));
  const { data: contentRows } = lessonIds.length
    ? await supabase
        .from('lesson_content')
        .select('lesson_id, content, video_id, video_provider, video_bytes, video_expires_at')
        .in('lesson_id', lessonIds)
    : { data: [] };

  const contentByLesson = Object.fromEntries(
    (contentRows ?? []).map((row) => [
      row.lesson_id,
      {
        content: row.content,
        videoId: row.video_id,
        videoProvider: row.video_provider,
        videoBytes: row.video_bytes,
        videoExpiresAt: row.video_expires_at,
      },
    ]),
  );

  // Everything else this course needs: what it costs. Which cursus carry it is
  // no longer this page's question — a cursus is built on its own screen, where
  // its modules and years are chosen. Live classes have their own screen too,
  // and a module is attached to a session from that side.
  const { data: feeRows } = await supabase
    .from('products')
    .select(
      'id, delivery, price_cents, duration_days, status, time_slot, schedule_label, hours_per_year, hours_per_week',
    )
    .eq('kind', 'module')
    .eq('course_id', id)
    .order('delivery');

  const fees: CourseFee[] = (feeRows ?? []).map((f) => ({
    id: f.id,
    delivery: f.delivery,
    priceCents: f.price_cents,
    durationDays: f.duration_days,
    status: f.status,
    timeSlot: f.time_slot,
    scheduleLabel: f.schedule_label,
    hoursPerYear: f.hours_per_year,
    hoursPerWeek: f.hours_per_week,
  }));

  // The groups this module's live sessions are taught to, with their rosters.
  const classes = await listClassesWithMembers(course.id);

  // Each group's content for each lesson — the text and video the lesson form
  // edits, once a group is chosen. Staff read every row.
  const { data: classContentRows } = lessonIds.length
    ? await supabase
        .from('class_lesson_content')
        .select(
          'class_id, lesson_id, content, video_id, video_provider, video_bytes, video_expires_at, attachments',
        )
        .in('lesson_id', lessonIds)
    : { data: [] };

  const classContentByLesson = new Map<string, OutlineClassContent[]>();
  for (const row of classContentRows ?? []) {
    const list = classContentByLesson.get(row.lesson_id) ?? [];
    list.push({
      classId: row.class_id,
      content: row.content,
      videoId: row.video_id ?? '',
      videoProvider: row.video_provider,
      videoBytes: row.video_bytes,
      videoExpiresAt: row.video_expires_at,
      documents: readDocuments(row.attachments),
    });
    classContentByLesson.set(row.lesson_id, list);
  }

  const modules = (course.modules ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      id: m.id,
      title: m.title,
      position: m.position,
      lessons: (m.lessons ?? [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((l) => ({
          id: l.id,
          title: l.title,
          type: l.type,
          position: l.position,
          minutes: Math.round(l.duration_seconds / 60),
          isPreview: l.is_preview,
          content: contentByLesson[l.id]?.content ?? '',
          videoId: contentByLesson[l.id]?.videoId ?? '',
          videoProvider: contentByLesson[l.id]?.videoProvider ?? 'none',
          videoBytes: contentByLesson[l.id]?.videoBytes ?? 0,
          videoExpiresAt: contentByLesson[l.id]?.videoExpiresAt ?? null,
          classContent: classContentByLesson.get(l.id) ?? [],
        })),
    }));

  return (
    <div>
      <Link
        href="/admin/courses"
        className="inline-flex items-center gap-2 text-xs text-ink-muted transition-colors hover:text-brand-600"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {t('backToCourses')}
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <h1 className="font-display text-2xl font-semibold text-ink">{course.title}</h1>
        <PublishControls courseId={course.id} status={course.status} slug={course.slug} />
      </div>

      <div className="mt-6">
        <CourseSteps
          formId="course-details"
          needsStatusChoice={course.status === 'draft'}
          steps={[
            {
              key: 'details',
              label: t('tabDetails'),
              content: <CourseSettingsForm
                formId="course-details"
                course={{
                  id: course.id,
                  title: course.title,
                  slug: course.slug,
                  subtitle: course.subtitle,
                  schedule: course.schedule,
                  description: course.description,
                  title_ar: course.title_ar,
                  level: course.level,
                  format: course.format,
                  duration_weeks: course.duration_weeks,
                  requirements: readBullets(course.requirements),
                  highlights: readHighlights(course.highlights),
                }}
              />,
            },
            {
              key: 'content',
              label: t('tabContent'),
              content: (
                <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px]">
                  <CourseOutline
                    courseId={course.id}
                    modules={modules}
                    classes={classes.map((klass) => ({ id: klass.id, name: klass.name }))}
                  />
                  <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
                    <CoverUpload courseId={course.id} coverUrl={course.cover_url} />
                    <GalleryUpload courseId={course.id} images={readGallery(course.gallery)} />
                  </aside>
                </div>
              ),
            },
            {
              key: 'fees',
              label: t('tabFees'),
              content: (
                <div className="max-w-3xl">
                  <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
                    {t('tabFeesLead')}
                  </p>
                  <CourseFees courseId={course.id} fees={fees} />
                </div>
              ),
            },
            {
              key: 'classes',
              label: t('tabClasses'),
              content: (
                <ClassManager
                  courseId={course.id}
                  classes={classes}
                  lessons={modules.flatMap((m) =>
                    m.lessons.map((lesson) => ({ id: lesson.id, title: lesson.title })),
                  )}
                />
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
