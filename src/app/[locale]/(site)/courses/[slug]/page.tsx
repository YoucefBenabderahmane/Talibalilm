import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { BookOpen, Check, Clock, Lock, PlayCircle, Radio, Users } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CourseCard } from '@/components/marketing/CourseCard';
import { CursusProgramme } from '@/components/marketing/CursusProgramme';
import { PlanningTarifs } from '@/components/marketing/PlanningTarifs';
import { InfoCarousel } from '@/components/courses/InfoCarousel';
import { CheckoutFlow } from '@/components/checkout/CheckoutFlow';
import { getCourse, getInstructor, relatedCourses } from '@/lib/data/courses';
import { createClient } from '@/lib/supabase/server';
import { currentViewer, isStaff } from '@/lib/auth/guards';
import { listCursus, listProducts } from '@/lib/data/commerce';
import { moduleRoutes } from '@/lib/commerce/module-modes';
import { listLiveSessions } from '@/lib/data/live';
import { institut } from '@/lib/content/institut';
import { lessonCount } from '@/lib/content/types';
import { siteUrl } from '@/lib/env';
import { requireLocale, routing } from '@/i18n/routing';
import { cn } from '@/lib/utils';

/**
 * A module's page, in the order the school's own page says things.
 *
 * Which department it belongs to, who may enrol, what is worth knowing at a
 * glance, photographs, the programme, the timetable and its prices, the live
 * sessions — and then, at the bottom, the enrolment card itself. A student who
 * has just read what is taught should be able to pay without going anywhere,
 * which is why the whole checkout is here rather than behind a link.
 *
 * Rendered per request rather than cached. The enrolment card reads the
 * visitor's own selection cookie, and a page that shows one person's basket is
 * not a page that may be served to the next one.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  requireLocale(locale);
  const course = await getCourse(slug);
  if (!course) return {};

  const t = await getTranslations({ locale, namespace: 'courses' });
  return {
    title: course.title,
    description: course.subtitle,
    alternates: {
      canonical:
        locale === routing.defaultLocale ? `/courses/${slug}` : `/${locale}/courses/${slug}`,
      languages: { fr: `/courses/${slug}`, en: `/en/courses/${slug}` },
    },
    openGraph: {
      type: 'article',
      title: course.title,
      description: course.subtitle,
      images: [{ url: course.cover_url ?? '/branding/og.png' }],
    },
    other: { 'course:level': t(`level.${course.level}`) },
  };
}

function formatMinutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

/** The three icons under the department block, in the order they are typed. */
const HIGHLIGHT_ICONS = [BookOpen, Users, Clock] as const;

export default async function CoursePage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  const course = await getCourse(slug);
  if (!course || course.status !== 'published') notFound();

  // Does the signed-in student already hold this module? `has_course_access`
  // is the same answer the lesson pages are gated by — bought outright, or
  // covered by a cursus they paid for, in the mode they paid for. A signed-out
  // visitor never reaches the question.
  //
  // Staff are a second answer to the same question. Their access comes from
  // `is_staff()` in the policies, not from an entitlement — every lesson is
  // already readable to them — so the enrolment card was offering the teacher
  // a course they can already open.
  //
  // `owned` is what the page turns into access: the lesson list becomes links
  // and the enrolment section is not rendered at all. A student who has just
  // paid lands here, not on a card asking them to open what they now hold.
  const viewer = await currentViewer();
  const supabase = await createClient();
  const owned = viewer
    ? isStaff(viewer) ||
      (await supabase.rpc('has_course_access', { cid: course.id })).data === true
    : false;

  const t = await getTranslations('courses');
  const tCommon = await getTranslations('common');
  const tMeta = await getTranslations('meta');
  const tNav = await getTranslations('nav');
  const tLive = await getTranslations('live');

  const [instructor, related, onSite, online, cursusList, liveSessions] = await Promise.all([
    getInstructor(course.instructor_id),
    relatedCourses(course),
    listProducts('presentiel'),
    listProducts('online'),
    listCursus(),
    listLiveSessions(course.id),
  ]);

  // This module's own price lines, in both modes, for the Planning & Tarifs
  // block. Read from `products` like every other price: the page never invents
  // a figure the checkout would then disagree with.
  const entries = [...onSite, ...online].filter(
    (entry) => entry.kind === 'module' && entry.courseId === course.id,
  );

  // Which cursus this module belongs to, from the programme grid the cursus
  // screen writes. That is what decides whether the checkout offers the
  // approfondi route on this page; the à-la-carte route is always offered once
  // the module has a price, because every module is sold on its own.
  const { data: gridRows } = await supabase
    .from('cursus_courses')
    .select('cursus_id')
    .eq('course_id', course.id);
  const inCursus = new Set((gridRows ?? []).map((row) => row.cursus_id));
  const approfondiIds = cursusList
    .filter((c) => c.kind === 'approfondi' && inCursus.has(c.id))
    .map((c) => c.id);

  // The cursus programmes this module belongs to, when there is something to
  // show — the office's poster and/or the written outline. Shown under the
  // module's own programme, so a student reading what is taught here also sees
  // the whole cursus it is part of.
  const cursusProgrammes = cursusList.filter(
    (c) =>
      c.kind === 'approfondi' &&
      inCursus.has(c.id) &&
      (c.imageUrl !== null || c.details.trim() !== ''),
  );

  // How this module is sold, from its own price lines: a module that costs
  // nothing opens directly, one that costs anything goes through the checkout.
  // No cursus row is consulted — a module is sold on its own whether or not
  // any cursus lists it, which is exactly what used to fail in silence.
  const { free: freeModes, paid: paidModes } = moduleRoutes(entries);

  const upcoming = liveSessions.filter((s) => s.status === 'scheduled' || s.status === 'live');
  const lessons = lessonCount(course);
  const hasDepartment = course.department !== '' || course.department_body !== '';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: course.title,
    description: course.description,
    url: `${siteUrl()}${locale === routing.defaultLocale ? '' : `/${locale}`}/courses/${course.slug}`,
    inLanguage: course.language,
    provider: {
      '@type': 'EducationalOrganization',
      name: tMeta('siteName'),
      url: siteUrl(),
    },
    ...(instructor && { instructor: { '@type': 'Person', name: instructor.full_name } }),
    hasCourseInstance: {
      '@type': 'CourseInstance',
      courseMode: course.format === 'presentiel' ? 'onsite' : 'blended',
      courseWorkload: `P${course.duration_weeks}W`,
    },
    ...(entries.length > 0 && {
      offers: entries.map((entry) => ({
        '@type': 'Offer',
        category: 'Subscription',
        price: (entry.priceCents / 100).toFixed(2),
        priceCurrency: entry.currency || institut.currency,
        availability: 'https://schema.org/InStock',
      })),
    }),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* The title band. Dark, with the Arabic name under the French one —
          the school's own page opens on exactly this. */}
      <section className="relative isolate -mt-18 overflow-hidden bg-brand-900 pt-18">
        {course.cover_url && (
          <div
            className="absolute inset-0 bg-cover bg-center opacity-25 mix-blend-luminosity"
            style={{ backgroundImage: `url('${course.cover_url}')` }}
            aria-hidden="true"
          />
        )}
        <div
          className="absolute inset-0 bg-linear-to-r from-brand-900 via-brand-900/95 to-brand-800/80"
          aria-hidden="true"
        />

        <div className="shell relative py-14 text-center sm:py-16 lg:py-20">
          <nav
            aria-label={tCommon('breadcrumb')}
            className="mb-6 flex flex-wrap items-center justify-center gap-1.5 text-xs text-white/60"
          >
            <Link href="/" className="transition-colors hover:text-gold-300">
              {tNav('home')}
            </Link>
            <span aria-hidden="true">/</span>
            <Link href="/courses" className="transition-colors hover:text-gold-300">
              {tNav('courses')}
            </Link>
            <span aria-hidden="true">/</span>
            <span className="text-white/90">{course.title}</span>
          </nav>

          <p className="text-[11px] font-medium tracking-[0.18em] text-gold-300 uppercase">
            {t(`category.${course.category}`)}
          </p>
          <h1 className="mx-auto mt-4 max-w-3xl font-display text-[clamp(1.75rem,4.4vw,2.75rem)] leading-[1.14] font-semibold tracking-[-0.03em] text-white">
            {course.title}
          </h1>
          {course.title_ar && (
            <p lang="ar" dir="rtl" className="mt-3 font-arabic text-3xl text-gold-400">
              {course.title_ar}
            </p>
          )}
          {course.subtitle && (
            <p className="mx-auto mt-5 max-w-2xl text-[15px] leading-relaxed text-white/70">
              {course.subtitle}
            </p>
          )}

          {/* When the module is taught, typed in the module builder under the
              subtitle and shown in the same place here. */}
          {course.schedule && (
            <p className="mx-auto mt-3 flex max-w-2xl items-center justify-center gap-2 text-[13px] text-white/60">
              <Clock className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="whitespace-pre-line">{course.schedule}</span>
            </p>
          )}

          <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
            <Badge variant="soft">{t(`level.${course.level}`)}</Badge>
            <Badge variant="soft">{t(`format.${course.format}`)}</Badge>
            {lessons > 0 && <Badge variant="soft">{t('card.lessons', { count: lessons })}</Badge>}
            {course.duration_weeks > 0 && (
              <Badge variant="soft">{t('card.duration', { count: course.duration_weeks })}</Badge>
            )}
          </div>
        </div>
      </section>

      {/* Département — Conditions d'accès */}
      {(hasDepartment || course.requirements.length > 0 || course.description) && (
        <section className="pattern-islamic py-14 sm:py-16">
          <div className="shell grid gap-10 lg:grid-cols-2 lg:gap-16">
            <div>
              <h2 className="font-display text-[22px] font-semibold text-gold-600 sm:text-[26px]">
                {course.department || t('detail.departmentFallback')}
              </h2>
              <div className="mt-4 space-y-3 text-sm leading-relaxed text-ink-muted">
                {(course.department_body || course.description)
                  .split('\n')
                  .filter((p) => p.trim() !== '')
                  .map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
              </div>
            </div>

            <div>
              <h2 className="font-display text-[22px] font-semibold text-gold-600 sm:text-[26px]">
                {t('detail.requirements')}
              </h2>
              {course.requirements.length > 0 ? (
                <ol className="mt-4 space-y-3">
                  {course.requirements.map((requirement, index) => (
                    <li
                      key={requirement}
                      className="flex items-start gap-3 text-sm leading-relaxed text-ink-muted"
                    >
                      {/* Numbered, because the conditions are read in order —
                          each one assumes the one before it. */}
                      <span
                        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-50 font-display text-[11px] font-semibold text-brand-700"
                        aria-hidden="true"
                      >
                        {index + 1}.
                      </span>
                      {requirement}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-4 text-sm leading-relaxed text-ink-muted">
                  {t('detail.requirementsEmpty')}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* The three blocks */}
      {course.highlights.length > 0 && (
        <section className="bg-surface/60 py-12 sm:py-14">
          <div className="shell grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {course.highlights.slice(0, 6).map((highlight, index) => {
              const Icon = HIGHLIGHT_ICONS[index % HIGHLIGHT_ICONS.length]!;
              return (
                <div key={highlight.title} className="text-center">
                  <span
                    className="mx-auto flex size-14 items-center justify-center rounded-full bg-gold-500 text-white"
                    aria-hidden="true"
                  >
                    <Icon className="size-6" />
                  </span>
                  <h3 className="mt-4 font-display text-[16px] font-semibold text-ink">
                    {highlight.title}
                  </h3>
                  {highlight.body && (
                    <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
                      {highlight.body}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Informations */}
      {course.gallery.length > 0 && (
        <section className="py-14 sm:py-16">
          <div className="shell max-w-4xl">
            <h2 className="text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-gold-600">
              {t('detail.information')}
            </h2>
            <div className="mt-8">
              <InfoCarousel
                images={course.gallery}
                labels={{
                  previous: t('detail.slidePrevious'),
                  next: t('detail.slideNext'),
                  goTo: t('detail.slideGoTo'),
                }}
              />
            </div>
          </div>
        </section>
      )}

      {/* Programme */}
      {course.modules.length > 0 && (
        <section className="bg-surface/60 py-14 sm:py-16">
          <div className="shell">
            <h2 className="text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-gold-600">
              {t('detail.syllabus')}
            </h2>

            {/* The outline is public — it is the sales page. What is hidden is
                the lesson body and its video, which live behind RLS and are
                simply not in this payload. Nothing here is a disabled link
                over a real URL. */}
            <ol className="mx-auto mt-8 max-w-3xl space-y-4">
              {course.modules.map((module, i) => (
                <li
                  key={module.id}
                  className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-white"
                >
                  <div className="bg-ink px-5 py-4 text-white">
                    <p className="text-[11px] tracking-[0.14em] text-gold-300 uppercase">
                      {t('detail.module', { number: i + 1 })}
                    </p>
                    <h3 className="mt-1 font-display text-[16px] font-semibold">{module.title}</h3>
                  </div>

                  <ul className="divide-y divide-line px-5">
                    {module.lessons.map((lesson) =>
                      owned ? (
                        // Held: the lesson is the way in, from the page the
                        // student is already reading. Nothing to click twice.
                        <li key={lesson.id}>
                          <Link
                            href={`/dashboard/courses/${course.slug}/lessons/${lesson.id}`}
                            className="group flex items-center gap-3 py-3 transition-colors hover:bg-brand-50/40"
                          >
                            <PlayCircle
                              className="size-4 shrink-0 text-brand-500"
                              aria-hidden="true"
                            />
                            <span className="flex-1 text-[13px] text-ink group-hover:text-brand-600">
                              {lesson.title}
                            </span>
                            {lesson.is_preview && (
                              <Badge variant="soft">{t('detail.previewBadge')}</Badge>
                            )}
                            <span className="text-[11px] text-ink-muted tabular-nums">
                              {formatMinutes(lesson.duration_seconds)}
                            </span>
                          </Link>
                        </li>
                      ) : (
                        <li key={lesson.id} className="flex items-center gap-3 py-3">
                          {lesson.is_preview ? (
                            <PlayCircle
                              className="size-4 shrink-0 text-brand-500"
                              aria-hidden="true"
                            />
                          ) : (
                            <Lock
                              className="size-4 shrink-0 text-ink-muted/50"
                              aria-hidden="true"
                            />
                          )}
                          <span
                            className={cn(
                              'flex-1 text-[13px]',
                              lesson.is_preview ? 'text-ink' : 'text-ink-muted',
                            )}
                          >
                            {lesson.title}
                          </span>
                          {lesson.is_preview ? (
                            <Badge variant="soft">{t('detail.previewBadge')}</Badge>
                          ) : (
                            <span className="sr-only">{t('detail.lockedLabel')}</span>
                          )}
                          <span className="text-[11px] text-ink-muted tabular-nums">
                            {formatMinutes(lesson.duration_seconds)}
                          </span>
                        </li>
                      ),
                    )}
                  </ul>
                </li>
              ))}
            </ol>

            {course.objectives.length > 0 && (
              <div className="mx-auto mt-10 max-w-3xl rounded-[var(--radius-card)] border border-line bg-white p-6">
                <h3 className="font-display text-lg font-semibold text-ink">
                  {t('detail.objectives')}
                </h3>
                <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                  {course.objectives.map((objective) => (
                    <li
                      key={objective}
                      className="flex items-start gap-3 text-[13px] text-ink-muted"
                    >
                      <span
                        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600"
                        aria-hidden="true"
                      >
                        <Check className="size-3" />
                      </span>
                      {objective}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!owned && (
              <p className="mt-6 text-center text-xs text-ink-muted">{t('detail.lockedHint')}</p>
            )}
          </div>
        </section>
      )}

      {/* The cursus programmes this module belongs to. The poster the office
          uploaded and the written outline, so a student reading the module's
          own programme also sees the whole programme it is part of. */}
      {cursusProgrammes.length > 0 && (
        <section className="py-14 sm:py-16">
          <div className="shell max-w-3xl">
            {cursusProgrammes.map((cursus, index) => (
              <div key={cursus.id} className={index > 0 ? 'mt-12' : ''}>
                <h2 className="text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-gold-600">
                  {t('detail.cursusProgramme')}
                </h2>
                <p className="mt-3 text-center font-display text-[16px] font-semibold text-ink">
                  {cursus.title}
                </p>
                <CursusProgramme
                  alt={cursus.title}
                  imageUrl={cursus.imageUrl}
                  details={cursus.details}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Planning & Tarifs — the school's own timetable, priced, with the
          on-site / online toggle. */}
      {entries.length > 0 && <PlanningTarifs entries={entries} locale={locale} />}

      {/* The live sessions scheduled against this module.
          `live_sessions` is readable only by staff and by a student who holds
          the module, so this section simply is not here for a visitor who has
          not enrolled — the list is empty because the database answered empty,
          not because the page decided to hide it. */}
      {upcoming.length > 0 && (
        <section className="bg-surface/60 py-14 sm:py-16">
          <div className="shell max-w-3xl">
            <h2 className="text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-gold-600">
              {t('detail.liveTitle')}
            </h2>
            <p className="mt-3 text-center text-[13px] leading-relaxed text-ink-muted">
              {t('detail.liveLead')}
            </p>

            <ul className="mt-8 space-y-3">
              {upcoming.map((session) => (
                <li
                  key={session.id}
                  className="flex flex-wrap items-center gap-4 rounded-[var(--radius-card)] border border-line bg-white p-5"
                >
                  <span
                    className={cn(
                      'flex size-10 shrink-0 items-center justify-center rounded-full',
                      session.status === 'live'
                        ? 'bg-red-600 text-white'
                        : 'bg-gold-50 text-gold-600',
                    )}
                    aria-hidden="true"
                  >
                    <Radio className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-display text-[15px] font-semibold text-ink">
                      {session.title}
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-muted">
                      {session.status === 'live'
                        ? t('detail.liveNow')
                        : session.scheduledAt
                          ? new Intl.DateTimeFormat(locale, {
                              dateStyle: 'full',
                              timeStyle: 'short',
                            }).format(new Date(session.scheduledAt))
                          : t('detail.liveScheduled')}
                    </p>
                  </div>
                  {/* Entry is decided again at the door by `can_join_live`,
                      which also refuses a banned student and an ended room. */}
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/live/${session.roomToken}`}>{tLive('joinNow')}</Link>
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Inscriptions & paiements — the whole enrolment, in one card, here.
          Not rendered at all for a student who already holds the module: the
          programme above is the access, every lesson a link, and offering the
          checkout again would be selling what they own. */}
      {!owned && (
        <section id="inscription" className="scroll-mt-24 py-14 sm:py-16">
          <div className="shell max-w-3xl">
            <h2 className="text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-gold-600">
              {t('detail.enrolment')}
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-center text-[13px] leading-relaxed text-ink-muted">
              {t('detail.enrolmentLead')}
            </p>

            {/* The card knows which module it is standing on, so it does not ask
                — no "which cursus", no list of every module the school sells.
                The mode step resolves this course into its published product;
                the price is read from the products table server-side and the
                browser never posts one. */}
            <div className="mt-8">
              <CheckoutFlow
                locale={locale}
                moduleContext={{
                  courseId: course.id,
                  slug: course.slug,
                  title: course.title,
                  hasTariff: entries.length > 0,
                  approfondiIds,
                  freeModes,
                  paidModes,
                }}
              />
            </div>
          </div>
        </section>
      )}

      {/* Who teaches it, and what to read next */}
      {(instructor || related.length > 0) && (
        <section className="bg-surface/60 py-14 sm:py-16">
          <div className="shell">
            {instructor && (
              <div className="mx-auto max-w-2xl rounded-[var(--radius-card)] border border-line bg-white p-6 text-center">
                <h2 className="font-display text-lg font-semibold text-ink">
                  {t('detail.instructor')}
                </h2>
                <p className="mt-3 text-[14px] font-medium text-ink">{instructor.full_name}</p>
                <p className="text-[11px] text-ink-muted">{instructor.role}</p>
                {instructor.bio && (
                  <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
                    {instructor.bio}
                  </p>
                )}
              </div>
            )}

            {related.length > 0 && (
              <div className="mt-12">
                <h2 className="text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-gold-600">
                  {t('detail.related')}
                </h2>
                <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {related.map((c) => (
                    <CourseCard key={c.id} course={c} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
