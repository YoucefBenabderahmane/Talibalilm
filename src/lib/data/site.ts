import 'server-only';
import { unstable_cache } from 'next/cache';
import { createClient, createPublicClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { institut } from '@/lib/content/institut';
import { reportError } from '@/lib/observability/report';
import type { CatalogStatus, EventPhase } from '@/lib/supabase/database.types';

/**
 * The parts of the site the office writes: the announcement strip, the social
 * links, the events and the testimonials.
 *
 * The reads here are anonymous by nature — a banner does not depend on who is
 * looking — so they go through `createPublicClient()` and are cached. The
 * admin actions that change them call `revalidateTag` with the tags below,
 * which is what keeps a saved change from waiting a day to appear.
 */

export const SITE_SETTINGS_TAG = 'site-settings';
export const EVENTS_TAG = 'events';
export const REVIEWS_TAG = 'reviews';

export interface SiteSettings {
  announcementText: string;
  announcementHref: string;
  announcementEnabled: boolean;
  social: {
    facebook: string;
    instagram: string;
    tiktok: string;
    youtube: string;
    whatsapp: string;
  };
}

/**
 * What to show before the school has filled anything in — and what to fall
 * back to if the table is unreachable. A footer with no links is a worse
 * answer than the links we already had in the repository.
 */
const FALLBACK: SiteSettings = {
  announcementText: '',
  announcementHref: '',
  announcementEnabled: false,
  social: {
    facebook: institut.social.facebook,
    instagram: institut.social.instagram,
    tiktok: institut.social.tiktok,
    youtube: institut.social.youtube,
    whatsapp: '',
  },
};

/** A blank column means "not set", and falls back rather than rendering a dead link. */
function orFallback(value: string | null | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? fallback : trimmed;
}

const readSettings = unstable_cache(
  async (): Promise<SiteSettings> => {
    const supabase = createPublicClient();
    const { data, error } = await supabase
      .from('site_settings')
      .select(
        'announcement_text, announcement_href, announcement_enabled, facebook, instagram, tiktok, youtube, whatsapp',
      )
      .maybeSingle();

    if (error) {
      // Never fatal. The strip is decoration and the footer has defaults; a
      // settings table that is unreachable must not take down the whole site.
      reportError('site.settings', error);
      return FALLBACK;
    }
    if (!data) return FALLBACK;

    return {
      announcementText: data.announcement_text ?? '',
      announcementHref: data.announcement_href ?? '',
      announcementEnabled: Boolean(data.announcement_enabled),
      social: {
        facebook: orFallback(data.facebook, FALLBACK.social.facebook),
        instagram: orFallback(data.instagram, FALLBACK.social.instagram),
        tiktok: orFallback(data.tiktok, FALLBACK.social.tiktok),
        youtube: orFallback(data.youtube, FALLBACK.social.youtube),
        whatsapp: orFallback(data.whatsapp, ''),
      },
    };
  },
  ['site-settings'],
  { tags: [SITE_SETTINGS_TAG], revalidate: 86400 },
);

export async function getSiteSettings(): Promise<SiteSettings> {
  if (!supabaseConfigured) return FALLBACK;
  return readSettings();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventView {
  id: string;
  title: string;
  titleAr: string;
  excerpt: string;
  body: string;
  imageUrl: string | null;
  startsAt: string | null;
  location: string;
  href: string;
  status: CatalogStatus;
  /** Where the event is in its own life — à venir, en cours, terminé. */
  phase: EventPhase;
  displayOrder: number;
}

const EVENT_SELECT =
  'id, title, title_ar, excerpt, body, image_url, starts_at, location, href, status, phase, display_order';

function toEvent(row: {
  id: string;
  title: string;
  title_ar: string;
  excerpt: string;
  body: string;
  image_url: string | null;
  starts_at: string | null;
  location: string;
  href: string;
  status: CatalogStatus;
  phase: EventPhase;
  display_order: number;
}): EventView {
  return {
    id: row.id,
    title: row.title,
    titleAr: row.title_ar,
    excerpt: row.excerpt,
    body: row.body,
    imageUrl: row.image_url,
    startsAt: row.starts_at,
    location: row.location,
    href: row.href,
    status: row.status,
    phase: row.phase,
    displayOrder: row.display_order,
  };
}

const readEvents = unstable_cache(
  async (limit: number): Promise<EventView[]> => {
    const supabase = createPublicClient();
    const { data, error } = await supabase
      .from('events')
      .select(EVENT_SELECT)
      .eq('status', 'published')
      .order('display_order', { ascending: true })
      .order('starts_at', { ascending: false, nullsFirst: false })
      .limit(limit);

    if (error) {
      reportError('site.events', error);
      return [];
    }
    return (data ?? []).map(toEvent);
  },
  ['events-published'],
  { tags: [EVENTS_TAG], revalidate: 86400 },
);

/** Published events, for the home page. */
export async function listEvents(limit = 6): Promise<EventView[]> {
  if (!supabaseConfigured) return [];
  return readEvents(limit);
}

/**
 * Every event including drafts, for the office.
 *
 * Through the ORDINARY client, not the cached public one: which rows come back
 * depends on who is asking, and an answer that depends on the reader is an
 * answer that must never be cached and handed to the next one.
 */
export async function listAllEvents(): Promise<EventView[]> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('events')
    .select(EVENT_SELECT)
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) {
    reportError('site.events.all', error);
    return [];
  }
  return (data ?? []).map(toEvent);
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export interface ReviewView {
  id: string;
  authorName: string;
  authorContext: string;
  quote: string;
  rating: number;
  avatarUrl: string | null;
  status: CatalogStatus;
  displayOrder: number;
}

const REVIEW_SELECT =
  'id, author_name, author_context, quote, rating, avatar_url, status, display_order';

function toReview(row: {
  id: string;
  author_name: string;
  author_context: string;
  quote: string;
  rating: number;
  avatar_url: string | null;
  status: CatalogStatus;
  display_order: number;
}): ReviewView {
  return {
    id: row.id,
    authorName: row.author_name,
    authorContext: row.author_context,
    quote: row.quote,
    // Clamped on the way out as well as constrained on the way in: this number
    // becomes a loop that draws stars, and a row written by hand in the SQL
    // editor should not be able to draw two hundred of them.
    rating: Math.min(5, Math.max(1, Math.round(row.rating))),
    avatarUrl: row.avatar_url,
    status: row.status,
    displayOrder: row.display_order,
  };
}

const readReviews = unstable_cache(
  async (limit: number): Promise<ReviewView[]> => {
    const supabase = createPublicClient();
    const { data, error } = await supabase
      .from('reviews')
      .select(REVIEW_SELECT)
      .eq('status', 'published')
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      reportError('site.reviews', error);
      return [];
    }
    return (data ?? []).map(toReview);
  },
  ['reviews-published'],
  { tags: [REVIEWS_TAG], revalidate: 86400 },
);

export async function listReviews(limit = 9): Promise<ReviewView[]> {
  if (!supabaseConfigured) return [];
  return readReviews(limit);
}

export async function listAllReviews(): Promise<ReviewView[]> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('reviews')
    .select(REVIEW_SELECT)
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) {
    reportError('site.reviews.all', error);
    return [];
  }
  return (data ?? []).map(toReview);
}

// ---------------------------------------------------------------------------
// Contact messages
// ---------------------------------------------------------------------------

export interface ContactMessageView {
  id: string;
  name: string;
  email: string;
  subject: string;
  body: string;
  handledAt: string | null;
  createdAt: string;
}

/** The postbag. Staff only — RLS refuses this read to anybody else. */
export async function listContactMessages(limit = 200): Promise<ContactMessageView[]> {
  if (!supabaseConfigured) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('contact_messages')
    .select('id, name, email, subject, body, handled_at, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    reportError('site.contact.list', error);
    return [];
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    subject: row.subject,
    body: row.body,
    handledAt: row.handled_at,
    createdAt: row.created_at,
  }));
}
