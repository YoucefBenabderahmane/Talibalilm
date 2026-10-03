import type { AbstractIntlMessages } from 'next-intl';

/**
 * Which namespaces reach the browser.
 *
 * `NextIntlClientProvider` serialises whatever it is given into the RSC
 * payload of every page. Handing it the whole catalogue ships the pricing FAQ,
 * the legal copy and the admin form labels to an anonymous visitor reading the
 * home page — bytes spent against the LCP budget for strings nothing on that
 * page can render.
 *
 * Only namespaces used by Client Components belong here. Server Components
 * call `getTranslations()`, which never crosses the boundary — and so do the
 * server actions, which resolve `validation` and `authErrors` before returning,
 * so those never need to ship either.
 *
 * `tests/unit/client-messages.test.ts` fails the build if a Client Component
 * starts using a namespace that is not listed, so this cannot silently drift
 * into a MISSING_MESSAGE at runtime.
 */
const CLIENT_NAMESPACES = [
  'meta',
  'nav',
  'common',
  'auth',
  // The login form reads `?error=expiredLink|unexpected` itself — the page is
  // static, so those two sentences are resolved on the client now.
  'authErrors',
  'courses',
  'learn',
  'checkout',
  'profile',
  'notifications',
  'contact',
  'live',
] as const;

/** Admin labels ride along only inside the admin subtree. */
const ADMIN_NAMESPACES = [...CLIENT_NAMESPACES, 'admin'] as const;

function pick(messages: AbstractIntlMessages, namespaces: readonly string[]): AbstractIntlMessages {
  const out: Record<string, unknown> = {};
  for (const namespace of namespaces) {
    if (namespace in messages) out[namespace] = messages[namespace];
  }
  return out as AbstractIntlMessages;
}

export function clientMessages(messages: AbstractIntlMessages): AbstractIntlMessages {
  return pick(messages, CLIENT_NAMESPACES);
}

export function adminClientMessages(messages: AbstractIntlMessages): AbstractIntlMessages {
  return pick(messages, ADMIN_NAMESPACES);
}
