/**
 * Cache tags for the reads that belong to nobody.
 *
 * One tag covers the shop: the published courses and their programmes, the
 * prices and the packs. The admin actions that write any of them call
 * `revalidateTag(CATALOGUE_TAG)`, and the cached readers in `courses.ts` and
 * `commerce.ts` are rebuilt on the next request. The revalidate window is the
 * backstop for an edit that slipped through without a tag — a day of
 * staleness rather than five minutes of it.
 *
 * It was five minutes, then an hour, and five minutes was the single most
 * expensive number in the app: every cached reader refilled every five minutes
 * around the clock, and the pages that embed them (home, courses, sitemap)
 * rebuilt on the same clock. On a plan where function CPU is the scarce
 * resource, a day is the right backstop — the tag makes every real edit
 * immediate, so the window only bounds a change made directly in the database.
 *
 * A subtlety worth keeping: `packs` is genuinely clock-dependent (its RLS
 * policy filters on `now()`, and a pack can sell out), so it does NOT move to
 * the daily backstop — see `PACKS_TTL`.
 */
export const CATALOGUE_TAG = 'catalogue';

/** The longest a stale catalogue can survive an edit that forgot its tag. */
export const CATALOGUE_TTL = 86400;

/**
 * Packs stay hourly, unlike the rest of the catalogue.
 *
 * `packs_select_published` filters on `now()` (`starts_at`/`ends_at`), and a
 * pack can be exhausted through `claim_pack` with no tag involved, so the rows
 * this reader returns change with the clock rather than with an edit. Caching
 * that for a day would keep a finished offer in front of buyers. The rest of
 * the catalogue is office-set with no clock in the payload.
 */
export const PACKS_TTL = 3600;
