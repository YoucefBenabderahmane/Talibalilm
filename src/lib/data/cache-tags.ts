/**
 * Cache tags for the reads that belong to nobody.
 *
 * One tag covers the shop: the published courses and their programmes, the
 * prices and the packs. The admin actions that write any of them call
 * `revalidateTag(CATALOGUE_TAG)`, and the cached readers in `courses.ts` and
 * `commerce.ts` are rebuilt on the next request. The revalidate window is the
 * backstop for an edit that slipped through without a tag — five minutes of
 * staleness rather than an hour of it.
 */
export const CATALOGUE_TAG = 'catalogue';

/** The longest a stale catalogue can survive an edit that forgot its tag. */
export const CATALOGUE_TTL = 300;
