import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ArrowRight, Layers } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { PageHero } from '@/components/marketing/PageHero';
import { CursusProgramme } from '@/components/marketing/CursusProgramme';
import { getCursus, getProgramme, programmeByYear } from '@/lib/data/commerce';
import { currentViewer } from '@/lib/auth/guards';
import { createClient } from '@/lib/supabase/server';
import { requireLocale } from '@/i18n/routing';
import { cn } from '@/lib/utils';

/**
 * One cursus, and every module it is made of.
 *
 * The home page's card folds the programme open; this is the page behind it —
 * what a student lands on after paying for a cursus, and where they choose the
 * module they want to open next. Every module is a link to its own page, and
 * that page is where access is decided (`has_course_access`): this one never
 * guesses, so it cannot disagree with the paywall.
 *
 * The programme is per delivery mode, because the grid is. No mode in the URL
 * shows whichever mode has a programme, so a cursus published in one mode only
 * does not open on an empty list.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  requireLocale(locale);
  const cursus = await getCursus(slug);
  if (!cursus) return {};

  return {
    title: cursus.title,
    description: cursus.description || cursus.subtitle,
  };
}

export default async function CursusPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const { locale, slug } = await params;
  requireLocale(locale);
  const { mode: modeParam } = await searchParams;
  setRequestLocale(locale);

  const cursus = await getCursus(slug);
  if (!cursus) notFound();

  // Both modes, in one round: the URL's mode wins, otherwise the one that has
  // a programme. Two queries, because an empty programme is not a page.
  const [presentiel, online] = await Promise.all([
    getProgramme(cursus.id, 'presentiel'),
    getProgramme(cursus.id, 'online'),
  ]);
  const requested = modeParam === 'online' ? 'online' : modeParam === 'presentiel' ? 'presentiel' : null;
  const mode = requested ?? (presentiel.length > 0 ? 'presentiel' : 'online');
  const years = programmeByYear(mode === 'online' ? online : presentiel);

  // Where "S'inscrire" goes now: the first module of the programme, whose own
  // page carries the checkout for both the module and this cursus. There is no
  // standalone checkout to send them to.
  const firstModule = [...years.values()].flat()[0] ?? null;

  const t = await getTranslations('cursus');
  const tCheckout = await getTranslations('checkout');

  // Does the viewer already hold this cursus? Their OWN entitlement rows, read
  // through RLS — this only decides whether to offer the checkout, and an
  // overdue installment is deliberately not considered here. Access itself is
  // answered per module, by the module page.
  let holds = false;
  const viewer = await currentViewer();
  if (viewer) {
    const supabase = await createClient();
    const { data } = await supabase
      .from('entitlements')
      .select('id')
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .or(`scope.eq.site,and(scope.eq.cursus,cursus_id.eq.${cursus.id})`)
      .limit(1);
    holds = (data?.length ?? 0) > 0;
  }

  const hasProgramme = cursus.imageUrl !== null || cursus.details.trim() !== '';

  return (
    <>
      <PageHero
        eyebrow={tCheckout(
          cursus.kind === 'approfondi' ? 'certificationApprofondi' : 'certificationModule',
        )}
        title={cursus.title}
        lead={cursus.subtitle || cursus.description}
        crumb={cursus.title}
      />

      {hasProgramme && (
        <section className="py-14 sm:py-16">
          <div className="shell max-w-3xl">
            <h2 className="text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-gold-600">
              {t('programme')}
            </h2>
            <CursusProgramme
              alt={cursus.title}
              imageUrl={cursus.imageUrl}
              details={cursus.details}
            />
          </div>
        </section>
      )}

      <section className={cn('py-14 sm:py-16', hasProgramme && 'bg-surface/60')}>
        <div className="shell">
          <h2 className="text-center font-display text-[clamp(1.5rem,3.4vw,2rem)] font-semibold text-gold-600">
            {t('modulesTitle')}
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-[13px] leading-relaxed text-ink-muted">
            {t('modulesLead')}
          </p>

          {/* The grid is per delivery mode, so the switch is too. Plain links:
              this page needs no JavaScript to change its mind. */}
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {(['presentiel', 'online'] as const).map((value) => (
              <Link
                key={value}
                href={`/cursus/${cursus.slug}?mode=${value}`}
                aria-current={mode === value ? 'page' : undefined}
                className={cn(
                  'rounded-full border px-4 py-2 text-[12px] font-medium transition-colors',
                  mode === value
                    ? 'border-brand-400 bg-brand-50 text-brand-700'
                    : 'border-line text-ink-muted hover:border-brand-300',
                )}
              >
                {value === 'presentiel' ? t('modePresentiel') : t('modeOnline')}
              </Link>
            ))}
          </div>

          {years.size === 0 ? (
            <p className="mx-auto mt-8 max-w-xl rounded-[var(--radius-card)] border border-dashed border-line bg-surface/50 p-8 text-center text-sm text-ink-muted">
              {t('empty')}
            </p>
          ) : (
            <div className="mx-auto mt-10 max-w-3xl space-y-10">
              {[...years.entries()].map(([year, entries]) => (
                <div key={year}>
                  <h3 className="font-display text-[15px] font-semibold text-gold-600">
                    {t('year', { year })}
                  </h3>

                  <ul className="mt-4 space-y-3">
                    {entries.map((entry) => (
                      <li key={entry.courseId}>
                        <Link
                          href={`/courses/${entry.courseSlug}`}
                          className="group flex items-center gap-4 rounded-[var(--radius-card)] border border-line bg-white p-4 transition-colors hover:border-brand-300"
                        >
                          <span
                            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"
                            aria-hidden="true"
                          >
                            <Layers className="size-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-display text-[15px] font-semibold text-ink transition-colors group-hover:text-brand-600">
                              {entry.courseTitle}
                            </span>
                            {entry.courseSubtitle && (
                              <span className="mt-0.5 block text-[12px] text-ink-muted">
                                {entry.courseSubtitle}
                              </span>
                            )}
                          </span>
                          <ArrowRight
                            className="size-4 shrink-0 text-ink-muted transition-colors group-hover:text-brand-600"
                            aria-hidden="true"
                          />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          <div className="mt-10 text-center">
            {holds ? (
              <p className="text-[13px] font-medium text-brand-700">{t('yourAccess')}</p>
            ) : firstModule ? (
              <Button asChild size="lg">
                <Link href={`/courses/${firstModule.courseSlug}#inscription`}>
                  {t('enrol')}
                </Link>
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}
