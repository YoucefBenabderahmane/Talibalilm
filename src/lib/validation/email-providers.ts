/**
 * The mailbox providers the school accepts for new accounts and subscriptions.
 *
 * A school address, a work domain or a throwaway mailbox is not refused because
 * it is fake, but because the school cannot reach it with certainty: welcome and
 * receipt mail is regularly filtered there, and the office spends its week
 * chasing addresses that bounce. This list is the providers whose
 * deliverability the school relies on.
 *
 * It gates registration and new orders only. Login, password reset and magic
 * links keep accepting any domain, so an account opened before the rule — or by
 * the office, on any address — still works.
 *
 * `hotmail`, `outlook`, `live` and `yahoo` exist under country suffixes
 * (`hotmail.fr`, `outlook.co.uk`, `yahoo.com.br`); the pattern accepts those
 * without pretending to enumerate every public suffix. Gmail, Googlemail,
 * iCloud and its aliases have no country forms and are matched exactly.
 */

const EXACT_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'yahoo.com',
  'ymail.com',
  'rocketmail.com',
  'icloud.com',
  'me.com',
  'mac.com',
]);

const COUNTRY_VARIANT = /^(hotmail|outlook|live|yahoo)\.[a-z]{2,3}(\.[a-z]{2})?$/;

/** True when `email` belongs to one of the accepted providers. */
export function isAllowedProviderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return EXACT_DOMAINS.has(domain) || COUNTRY_VARIANT.test(domain);
}
