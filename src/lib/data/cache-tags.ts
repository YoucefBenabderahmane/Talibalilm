/**
 * Cache tags for the reads that belong to nobody.
 *
 * One tag covers the shop: the published courses and their programmes, the
 * prices and the packs. The admin actions that write any of them call
 * `revalidateTag(CATALOGUE_TAG)`, and the cached readers in `courses.ts` and
 * `commerce.ts` are rebuilt on the next request. The revalidate window is the
 * backstop for an edit that slipped through without a tag — an hour of
 * staleness rather than five minutes of it.
 *
 * It was five minutes, and that was the single most expensive number in the
 * app: every cached reader refilled every five minutes around the clock, and
 * the pages that embed them (home, courses, sitemap) rebuilt on the same
 * clock. On a plan where function CPU is the scarce resource, an hour is the
 * right trade — the tag makes every real edit immediate, so the window only
 * bounds a change made directly in the database.
 */
export const CATALOGUE_TAG = 'catalogue';

/** The longest a stale catalogue can survive an edit that forgot its tag. */
export const CATALOGUE_TTL = 3600;
