import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { CourseCard } from '@/components/marketing/CourseCard';
import { PageHero } from '@/components/marketing/PageHero';
import { listCourses } from '@/lib/data/courses';
import { requireLocale } from '@/i18n/routing';

/**
 * One list, no facets.
 *
 * The catalogue used to carry a category filter — a row of chips above the
 * grid, fed from the URL. The school asked for it gone: a module is taught to
 * whoever enrols, and splitting a small catalogue by subject offered a
 * distinction it does not actually make. The `category` column stays (the
 * generated cover art used to print it), it just no longer drives a screen.
 *
 * The list is the same for every reader, so the page is static and rebuilds on
 * the catalogue's clock rather than on every visit. The literal is Next's
 * requirement; keep it equal to `CATALOGUE_TTL` in `@/lib/data/cache-tags`.
 */
export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  requireLocale(locale);
  const t = await getTranslations({ locale, namespace: 'courses' });
  return { title: t('title'), description: t('lead') };
}

export default async function CoursesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  const t = await getTranslations('courses');
  const results = await listCourses();

  return (
    <>
      <PageHero
        crumb={t('title')}
        eyebrow={t('eyebrow')}
        title={t('title')}
        lead={t('lead')}
      />

      <section className="pattern-islamic py-14 sm:py-16">
        <div className="shell">
          <p className="text-xs text-ink-muted" aria-live="polite">
            {t('resultCount', { count: results.length })}
          </p>

          {results.length > 0 ? (
            <div className="mt-5 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {results.map((course) => (
                <CourseCard key={course.id} course={course} />
              ))}
            </div>
          ) : (
            <p className="mt-10 rounded-[var(--radius-card)] border border-dashed border-line bg-surface/50 p-10 text-center text-sm text-ink-muted">
              {t('empty')}
            </p>
          )}
        </div>
      </section>
    </>
  );
}
