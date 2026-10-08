import { getTranslations, setRequestLocale } from 'next-intl/server';
import { GraduationCap } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { CourseCard } from '@/components/marketing/CourseCard';
import { CursusCard } from '@/components/marketing/CursusCard';
import { EventsSection } from '@/components/marketing/EventsSection';
import { ReviewsSection } from '@/components/marketing/ReviewsSection';
import { listCourses } from '@/lib/data/courses';
import { listCursus } from '@/lib/data/commerce';
import { listEvents, listReviews } from '@/lib/data/site';
import { institut } from '@/lib/content/institut';
import { siteUrl } from '@/lib/env';
import { requireLocale } from '@/i18n/routing';

/**
 * Static, rebuilt on the catalogue's clock.
 *
 * Nothing on this page depends on the reader: the catalogue, the cursus list,
 * the events and the reviews are all public rows read through cached,
 * cookie-free clients. Without the cookie read it prerenders; `revalidate` is
 * what makes an admin edit show up without a deploy — and `revalidateTag`
 * (see `CATALOGUE_TTL` in `@/lib/data/cache-tags`) makes it immediate.
 *
 * The number is a literal because Next reads it statically; keep it equal to
 * `CATALOGUE_TTL`. It was 300, then 3600, and regenerating this page around
 * the clock was the largest single consumer of function CPU in the app — see
 * the note in `cache-tags.ts`. Admin edits still show immediately, through the
 * tag.
 */
export const revalidate = 86400;

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  const t = await getTranslations('home');
  const tCourses = await getTranslations('courses');
  const tCheckout = await getTranslations('checkout');
  const tMeta = await getTranslations('meta');

  const [courses, cursusList, events, reviews] = await Promise.all([
    listCourses(),
    listCursus(),
    listEvents(6),
    listReviews(9),
  ]);

  const orgJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'EducationalOrganization',
    name: tMeta('siteName'),
    description: tMeta('defaultDescription'),
    url: siteUrl(),
    email: institut.email,
    telephone: institut.phone,
    address: {
      '@type': 'PostalAddress',
      streetAddress: institut.addressLines[0],
      addressLocality: 'Montereau-Fault-Yonne',
      postalCode: '77130',
      addressCountry: 'FR',
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
      />

      {/* Hero. Centred, with the Arabic name under the French one and a single
          gold call to action — the school's own opening. It reaches up behind
          the header, which is sticky rather than fixed, so the two share one
          wash instead of meeting at a seam. */}
      <section className="hero-wash relative isolate -mt-18 overflow-hidden pt-18">
        {/* eslint-disable-next-line @next/next/no-img-element -- decorative SVG, no optimisation to gain */}
        <img
          src="/media/hero-mosque.svg"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full object-cover opacity-25 select-none"
        />

        <div className="shell relative py-16 text-center sm:py-20 lg:py-28">
          <p className="text-[11px] font-medium tracking-[0.2em] text-gold-600 uppercase">
            {t('hero.eyebrow')}
          </p>
          <h1 className="mx-auto mt-5 max-w-3xl font-display text-[clamp(2rem,5.2vw,3.25rem)] leading-[1.12] font-semibold tracking-[-0.03em] text-ink">
            {t('hero.title')}
          </h1>
          <p lang="ar" dir="rtl" className="mt-4 font-arabic text-3xl text-gold-600 sm:text-4xl">
            {t('heroTitleAr')}
          </p>
          <p className="mx-auto mt-6 max-w-2xl text-[15px] leading-relaxed text-ink-muted">
            {t('hero.body')}
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Button asChild size="lg" variant="gold">
              <Link href="/courses">{t('hero.cta')}</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/register">{t('closing.primary')}</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* L'institut en bref.

          The column of figures that used to sit beside this is gone. It was
          computed honestly from the catalogue, which is how it came to read
          "0 modules, 0 chapitres, 0 séances" — an accurate advertisement for
          having nothing. Numbers go back when there is something to count. */}
      <section className="pattern-islamic border-y border-line/70 py-16 sm:py-20">
        <div className="shell max-w-3xl text-center">
          <h2 className="font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-gold-600">
            {t('brief.title')}
          </h2>
          <p className="mt-6 text-sm leading-relaxed text-ink-muted">{t('brief.body')}</p>
          <p className="mt-4 text-sm leading-relaxed text-ink-muted">{t('brief.body2')}</p>

          <div className="mt-8">
            <Button asChild size="md" variant="goldOutline">
              <Link href="/courses">{t('brief.cta')}</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Actualités & événements. Renders nothing at all while the table is
          empty — a heading over an empty grid advertises that the institute has
          no news. The testimonials sit further down, after the three steps. */}
      <EventsSection events={events} locale={locale} />

      {/* Découvrez nos formations.

          Seven hard-coded disciplines used to sit here, most of them with no
          module behind them, while the real catalogue was shown again further
          down the page. One section now, and it shows what the school has
          actually published. */}
      {courses.length > 0 && (
        <section className="bg-surface/60 py-16 sm:py-20">
          <div className="shell">
            <h2 className="text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-gold-600">
              {t('formations.title')}
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-[13px] leading-relaxed text-ink-muted">
              {t('formations.lead')}
            </p>

            <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {courses.slice(0, 6).map((course) => (
                <CourseCard key={course.id} course={course} />
              ))}
            </div>

            <div className="mt-10 text-center">
              <Button asChild size="md" variant="gold">
                <Link href="/courses">{t('formations.cta')}</Link>
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Les cursus — the two ways through the school. The programme itself
          (an image or a written outline the office uploads) opens inside the
          card, so reading what a cursus covers never leaves the page. */}
      {cursusList.length > 0 && (
        <section className="pattern-islamic py-16 sm:py-20">
          <div className="shell">
            <h2 className="text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-gold-600">
              {t('cursus.title')}
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-[13px] leading-relaxed text-ink-muted">
              {t('cursus.lead')}
            </p>

            {/*
              Only the real programmes. The catalogue can also hold a
              `kind = 'module'` cursus row — the old "À la carte" pseudo-cursus
              — and a card for it here duplicated what the module list already
              says, under a name the school does not use.
            */}
            <ul className="mt-10 grid gap-6 md:grid-cols-2">
              {cursusList
                .filter((cursus) => cursus.kind === 'approfondi')
                .map((cursus) => (
                  <CursusCard
                    key={cursus.id}
                    slug={cursus.slug}
                    title={cursus.title}
                    subtitle={cursus.subtitle}
                    description={cursus.description}
                    details={cursus.details}
                    imageUrl={cursus.imageUrl}
                    yearCount={cursus.yearCount}
                    icon={<GraduationCap className="size-6" aria-hidden="true" />}
                    certification={tCheckout('certificationApprofondi')}
                    labels={{
                      years: tCourses('card.years', { count: cursus.yearCount }),
                      view: t('cursus.cta'),
                      hide: t('cursus.ctaClose'),
                      enrol: t('cursus.enrol'),
                      programme: t('cursus.programme'),
                    }}
                  />
                ))}
            </ul>
          </div>
        </section>
      )}

      {/* How it works */}
      <section className="bg-surface/60 py-16 sm:py-20">
        <div className="shell">
          <p className="text-center text-[11px] tracking-[0.18em] text-gold-600 uppercase">
            {t('how.eyebrow')}
          </p>
          <h2 className="mx-auto mt-4 max-w-xl text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-ink">
            {t('how.title')}
          </h2>

          <ol className="mt-12 grid gap-8 md:grid-cols-3">
            {([1, 2, 3] as const).map((n) => (
              <li key={n} className="text-center">
                <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-brand-500 font-display text-lg font-semibold text-white shadow-brand">
                  {n}
                </span>
                <h3 className="mt-4 font-display text-[16px] font-semibold text-ink">
                  {t(`how.step${n}Title`)}
                </h3>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
                  {t(`how.step${n}Body`)}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* What students say, last before the closing band: it reads as the
          argument for taking the three steps above, rather than as an
          interruption between the news and the catalogue. Absent while no
          review is published. */}
      <ReviewsSection reviews={reviews} />

      {/* Closing band. The mosque line drawing sits behind the emerald wash,
          darkened rather than lit, so the band reads as one deep surface and
          the text keeps its contrast. */}
      <section className="relative isolate overflow-hidden bg-brand-900">
        {/* eslint-disable-next-line @next/next/no-img-element -- decorative SVG, no optimisation to gain */}
        <img
          src="/media/hero-mosque.svg"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full object-cover opacity-20 select-none"
        />
        <div
          className="absolute inset-0 bg-linear-to-b from-brand-900/80 via-brand-900/60 to-brand-900/90"
          aria-hidden="true"
        />
        <div className="shell relative py-16 text-center sm:py-20">
          <h2 className="mx-auto max-w-2xl font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-white">
            {t('closing.title')}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[14px] leading-relaxed text-white/70">
            {t('closing.body')}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Button asChild size="lg" variant="gold">
              <Link href="/register">{t('closing.primary')}</Link>
            </Button>
            <Link
              href="/courses"
              className="text-[12px] font-semibold tracking-[0.12em] text-white uppercase transition-colors hover:text-gold-300"
            >
              {t('closing.secondary')}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
