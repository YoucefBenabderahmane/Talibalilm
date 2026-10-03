import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { AuthCard } from '@/components/auth/AuthCard';
import { LoginForm } from '@/components/auth/LoginForm';
import { requireLocale } from '@/i18n/routing';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  requireLocale(locale);
  const t = await getTranslations({ locale, namespace: 'auth' });
  return { title: t('loginTitle'), robots: { index: false, follow: false } };
}

export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  const t = await getTranslations('auth');

  // `?next=`, `?reset=1` and `?error=` are read by the form, on the client.
  // Reading them here made every login render on the server for a redirect
  // hint and a message that only exist after an arrival — the page is static
  // now, and the form says those things itself.
  return (
    <AuthCard
      title={t('loginTitle')}
      lead={t('loginLead')}
      footer={
        <>
          {t('noAccount')}{' '}
          <Link href="/register" className="text-brand-600 underline underline-offset-4">
            {t('submitRegister')}
          </Link>
        </>
      }
    >
      <LoginForm />
    </AuthCard>
  );
}
