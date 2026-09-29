'use client';

import { useEffect, useState } from 'react';

/**
 * What a visitor sees when a page throws.
 *
 * Without this file Next renders its own bare "Application error: a
 * server-side exception has occurred", which tells a teacher nothing and tells
 * whoever is fixing it only a digest they have nowhere to put.
 *
 * Deliberately written without next-intl. An error boundary that itself needs
 * a translation context is an error boundary that fails when the layout is
 * what broke — and then the visitor gets Next's bare page anyway. The two
 * languages are inlined, and the locale is read from the URL after mount: the
 * address bar is the one thing that still works when the app does not.
 *
 * The digest is shown on purpose. Next strips the real message from the
 * browser in production, by design, but every server log line for this error
 * carries the same digest — so this is the one string that turns "something
 * broke" into a log search that lands on the actual stack.
 */
const COPY = {
  fr: {
    title: 'Cette page n’a pas pu s’afficher',
    body: 'Une erreur s’est produite de notre côté. Réessayez — si cela se répète, communiquez le code ci-dessous, il permet de retrouver la cause exacte dans les journaux.',
    retry: 'Réessayer',
    home: 'Retour à l’accueil',
  },
  en: {
    title: 'This page could not be displayed',
    body: 'Something went wrong on our side. Try again — if it keeps happening, quote the code below: it points to the exact cause in the logs.',
    retry: 'Try again',
    home: 'Back to the home page',
  },
} as const;

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = useState<'fr' | 'en'>('fr');

  useEffect(() => {
    // The browser console gets what it can, which on a production build is the
    // digest and little else. The server already logged the rest.
    console.error('[page]', error.digest ?? '', error.message);

    // In an effect, not in the initial state: the server and the first client
    // render must agree, and the server cannot read `window`.
    setLocale(
      window.location.pathname === '/en' || window.location.pathname.startsWith('/en/') ? 'en' : 'fr',
    );
  }, [error]);

  const copy = COPY[locale];

  return (
    <section className="flex min-h-[60vh] items-center py-20">
      <div className="shell max-w-lg text-center">
        <h1 className="font-display text-2xl font-semibold text-ink">{copy.title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">{copy.body}</p>

        {error.digest && (
          <p className="mt-4 inline-block rounded-lg bg-surface px-3 py-2 font-mono text-[12px] text-ink-muted">
            {error.digest}
          </p>
        )}

        <div className="mt-8 flex justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-full bg-brand-500 px-5 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-brand-600"
          >
            {copy.retry}
          </button>
          {/* A plain anchor, deliberately. A client-side navigation would
              reuse the React tree that just threw; a full load starts clean,
              which is the whole point of the button. */}
          <a
            href={locale === 'en' ? '/en' : '/'}
            className="rounded-full border border-line px-5 py-2.5 text-[13px] text-ink transition-colors hover:border-brand-300"
          >
            {copy.home}
          </a>
        </div>
      </div>
    </section>
  );
}
