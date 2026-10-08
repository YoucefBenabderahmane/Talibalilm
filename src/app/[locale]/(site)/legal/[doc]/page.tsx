import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { PageHero } from '@/components/marketing/PageHero';
import { requireLocale, routing } from '@/i18n/routing';

/**
 * The three documents GDPR and French consumer law require.
 *
 * Placeholders on purpose: the real text has to come from the school's own
 * counsel, and inventing terms of sale or a privacy policy would be worse than
 * an honest "being drafted" — it would be a legal document nobody agreed to.
 * The routes exist now so the footer links resolve and the URLs are stable.
 */
const DOCS = ['terms', 'privacy', 'cookies'] as const;
type Doc = (typeof DOCS)[number];

const TITLE_KEY: Record<Doc, 'termsTitle' | 'privacyTitle' | 'cookiesTitle'> = {
  terms: 'termsTitle',
  privacy: 'privacyTitle',
  cookies: 'cookiesTitle',
};

export function generateStaticParams() {
  return routing.locales.flatMap((locale) => DOCS.map((doc) => ({ locale, doc })));
}

function asDoc(value: string): Doc | null {
  return (DOCS as readonly string[]).includes(value) ? (value as Doc) : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; doc: string }>;
}): Promise<Metadata> {
  const { locale, doc } = await params;
  requireLocale(locale);
  const key = asDoc(doc);
  if (!key) return {};

  const t = await getTranslations({ locale, namespace: 'legal' });
  // Placeholder text must never be indexed as the real policy.
  return { title: t(TITLE_KEY[key]), robots: { index: false, follow: true } };
}

export default async function LegalPage({
  params,
}: {
  params: Promise<{ locale: string; doc: string }>;
}) {
  const { locale, doc } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  const key = asDoc(doc);
  if (!key) notFound();

  const t = await getTranslations('legal');
  const updated = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date('2026-09-10'));

  return (
    <>
      <PageHero crumb={t(TITLE_KEY[key])} title={t(TITLE_KEY[key])} />

      <section className="py-14 sm:py-16">
        <div className="shell max-w-3xl">
          <p className="text-xs text-ink-muted">{t('lastUpdated', { date: updated })}</p>
          <p className="mt-6 rounded-[var(--radius-card)] border border-dashed border-line bg-surface/50 p-8 text-sm leading-relaxed text-ink-muted">
            {t('placeholder')}
          </p>
        </div>
      </section>
    </>
  );
}
