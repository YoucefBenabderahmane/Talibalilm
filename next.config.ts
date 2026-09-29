import { existsSync } from 'node:fs';
import path from 'node:path';
import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Resolve the school's artwork HERE, at build time, and inline the answer.
 *
 * It used to be resolved by probing the filesystem at request time. That works
 * for a statically generated page, which is rendered during the build with
 * `public/` on disk — and silently fails inside a serverless function, where
 * Next does not ship `public/` because the CDN serves it. So the public site
 * (prerendered) showed the real lockup while the admin sidebar (rendered per
 * request) fell through to the drawn placeholder. Same code, different moment.
 *
 * Doing it in the config keeps the handover intact — drop a file in, redeploy —
 * without leaving a filesystem read on the request path.
 */
function resolveArtwork(...candidates: string[]): string {
  const found = candidates.find((c) =>
    existsSync(path.join(process.cwd(), 'public', c.replace(/^\//, ''))),
  );
  return found ?? candidates[candidates.length - 1]!;
}

const LOGO_LOCKUP = resolveArtwork(
  '/branding/logo-institut.webp',
  '/branding/logo-institut.png',
  '/branding/logo-institut.jpg',
  '/branding/logo-institut.svg',
);
const LOGO_MARK = resolveArtwork(
  '/branding/logo-mark.webp',
  '/branding/logo-mark.png',
  '/branding/logo-mark.jpg',
  '/branding/logo-mark.svg',
);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // A Server Action body is capped at 1 MB by default, and the cover uploader
  // posts the file through one. That cap is SMALLER than the 5 MB the image
  // validator accepts, so for a long time every photo off a phone was refused
  // by a limit that reported no size and appeared nowhere in the code — while
  // `MAX_IMAGE_BYTES` sat there looking like the rule. Two limits that disagree
  // are worse than either, so this one matches the validator exactly. The
  // browser now re-encodes covers before sending (see `@/lib/media/downscale`),
  // which means this is the safety net rather than the everyday path.
  experimental: {
    serverActions: { bodySizeLimit: '5mb' },
  },

  // Inlined at build time; read through `@/lib/artwork`.
  env: {
    NEXT_PUBLIC_LOGO_LOCKUP: LOGO_LOCKUP,
    NEXT_PUBLIC_LOGO_MARK: LOGO_MARK,
  },

  // `typedRoutes` is off deliberately. It types the *filesystem* routes, which
  // under next-intl all live beneath `[locale]`, while next-intl's Link and
  // redirect take locale-less paths like `/courses`. The two never agree, and
  // the result is a cast at every call site — which is worse than no typing.
  // Route-level type safety comes back via next-intl's `pathnames` config when
  // we localise the URL segments themselves.

  // Supabase Storage serves avatars and course covers; nothing else is
  // remote yet. Each new host has to be added deliberately.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/public/**' },
    ],
    // A month, not Next's default minute. Every re-optimisation is a function
    // invocation, and a cover that changes once a term does not need one every
    // time the CDN entry ages out.
    minimumCacheTTL: 2678400,
  },

  // The five enrolment steps became one card at /checkout. Old links — a
  // student's bookmark, a PayPal return saved from before the change — land on
  // the step they were on; send them to the card, which reopens at the step
  // their selection cookie has reached.
  async redirects() {
    return [
      {
        source: '/en/checkout/:step(mode|modules|review|payment)',
        destination: '/en/checkout',
        permanent: false,
      },
      {
        source: '/checkout/:step(mode|modules|review|payment)',
        destination: '/checkout',
        permanent: false,
      },
      // Tarifs became Contact. Prices moved onto each module's own page, beside
      // the card that charges them, so the separate list had nothing left to
      // say that the catalogue did not already say better.
      { source: '/en/pricing', destination: '/en/contact', permanent: true },
      { source: '/pricing', destination: '/contact', permanent: true },
    ];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: [
              // The classroom is now our own page rather than a third-party
              // iframe, so every capture it needs is first-party. Naming an
              // outside origin here is exactly what is no longer required —
              // and `self` is the tightest this can be while the camera,
              // microphone and screen recording all work.
              'camera=(self)',
              'microphone=(self)',
              'display-capture=(self)',
              'geolocation=()',
            ].join(', '),
          },
        ],
      },
      {
        source: '/fonts/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
