'use client';

import { useEffect, useState } from 'react';

/**
 * The last resort: the root layout itself threw.
 *
 * This replaces the whole document, so it carries its own <html> and <body> and
 * leans on nothing — no fonts, no theme tokens, no providers, no translations.
 * Everything it might have depended on is, by definition, what just failed.
 *
 * The two languages are therefore inlined here, and the one is picked from the
 * URL after mount. French is what renders first, on the server and before the
 * effect runs, because French is the default the school publishes in.
 */
const COPY = {
  fr: {
    title: 'Le site est momentanément indisponible',
    body: 'Réessayez dans un instant. Si cela se répète, communiquez le code ci-dessous.',
    retry: 'Réessayer',
  },
  en: {
    title: 'The site is temporarily unavailable',
    body: 'Try again in a moment. If it keeps happening, quote the code below.',
    retry: 'Try again',
  },
} as const;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = useState<'fr' | 'en'>('fr');

  useEffect(() => {
    setLocale(
      window.location.pathname === '/en' || window.location.pathname.startsWith('/en/') ? 'en' : 'fr',
    );
  }, []);

  const copy = COPY[locale];

  return (
    <html lang={locale}>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'system-ui, sans-serif',
          background: '#fbfaf8',
          color: '#16221f',
          padding: '2rem',
        }}
      >
        <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>{copy.title}</h1>
          <p
            style={{
              marginTop: '0.75rem',
              fontSize: '0.875rem',
              lineHeight: 1.6,
              color: '#637471',
            }}
          >
            {copy.body}
          </p>
          {error.digest && (
            <p
              style={{
                marginTop: '1rem',
                fontFamily: 'ui-monospace, monospace',
                fontSize: '0.75rem',
                color: '#637471',
              }}
            >
              {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '2rem',
              border: 0,
              borderRadius: '999px',
              background: '#16221f',
              color: '#fff',
              padding: '0.625rem 1.25rem',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            {copy.retry}
          </button>
        </div>
      </body>
    </html>
  );
}
