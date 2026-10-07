'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { requireStaff } from '@/lib/auth/guards';
import { checkImage, MAX_IMAGE_BYTES } from '@/lib/media/image';
import { runPool } from '@/lib/media/pool';
import { deckKey, isDeckKey, isSlideKeyFor, safeFilename, slideKey, slideName } from '@/lib/storage/key';
import {
  deleteObject,
  r2Configured,
  readObjectHead,
  signDownload,
  signUpload,
} from '@/lib/storage/r2';
import { reportError } from '@/lib/observability/report';
import type { AdminState } from '@/app/actions/admin';
import { errorDetail } from '@/lib/supabase/error-detail';

/**
 * Slides for a live class.
 *
 * Upload is two steps on purpose, and both take a batch:
 *
 *   1. `requestSlideUploads` checks the caller is staff, that the class exists,
 *      and that the deck has room — then signs one URL per page, with keys it
 *      chooses. The browser PUTs the files straight to Cloudflare.
 *   2. `confirmSlides` reads the first bytes back out of the bucket and sniffs
 *      them. Only an actual PNG, JPEG or WebP becomes a row; anything else is
 *      deleted from the bucket and refused.
 *
 * The batch is not an optimisation of convenience: a hundred-page PDF used to
 * cost two server round trips per page before a byte moved, which is most of
 * what made a large deck feel slow.
 *
 * The second step is what keeps the codebase's oldest rule intact — a file is
 * judged by its bytes, never by the content type a browser claims — without
 * streaming every slide through a Vercel function to do it. An object with no
 * row is invisible to every read path in the app, so a failed confirm leaves
 * nothing reachable behind even if the delete also fails.
 *
 * Nothing here takes a bucket key on trust. `isSlideKeyFor` rejects a key that
 * is not this session's before any call to R2, and the table's own CHECK
 * refuses the same thing independently.
 */

const OK: AdminState = { ok: true };
/**
 * The most slides one session may hold.
 *
 * Raised from 200 for the school's long decks — a 400-page PDF is a normal
 * term's material — and the cap is now reported with a count rather than as a
 * bare "deck full".
 */
const MAX_SLIDES = 500;
/** Pages signed or confirmed in one round trip. Big enough to hide the latency, small enough to fail cheaply. */
const MAX_BATCH = 50;

async function staffClient() {
  if (!supabaseConfigured) throw new Error('unavailable');
  await requireStaff();
  return createClient();
}

export interface UploadTicket {
  /** Where the browser PUTs the file. Valid for a few minutes, for this key only. */
  url: string;
  key: string;
  contentType: string;
}

export interface UploadBatchResult extends AdminState {
  /** One ticket per page that fit under the deck cap, in order. */
  tickets?: UploadTicket[];
  /** Pages the deck had no room for — the caller says so rather than losing them silently. */
  skipped?: number;
}

const FINGERPRINT = z.string().regex(/^[a-f0-9]{64}$/);

const batchRequestSchema = z.object({
  sessionId: z.string().uuid(),
  pages: z
    .array(
      z.object({
        // The declared type decides the extension only. It is not believed: the
        // bytes are read back in `confirmSlides` before any slide exists.
        contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        byteSize: z.coerce.number().int().min(1).max(MAX_IMAGE_BYTES),
        /**
         * The PDF this page came from, when the caller has one. Present means
         * the page is filed under the shared deck prefix, so the next class
         * can reuse it; absent means a one-off image, filed under the session.
         */
        fingerprint: FINGERPRINT.optional(),
      }),
    )
    .min(1)
    .max(MAX_BATCH),
});

/**
 * Sign one PUT per page, in a single round trip.
 *
 * This used to be one call per page, which made a hundred-page PDF two hundred
 * server round trips before a single byte moved. One session read, one deck
 * count, then the URLs in parallel: the latency a deck pays is now per batch.
 */
export async function requestSlideUploads(input: {
  sessionId: string;
  pages: { contentType: string; byteSize: number; fingerprint?: string }[];
}): Promise<UploadBatchResult> {
  if (!r2Configured) return { ok: false, error: 'storageUnavailable' };

  const parsed = batchRequestSchema.safeParse(input);
  if (!parsed.success) {
    // A size over the cap is the one case worth naming: the teacher can act on it.
    const tooBig = parsed.error.issues.some((i) => i.path.includes('byteSize'));
    return { ok: false, error: tooBig ? 'tooLarge' : 'notAnImage' };
  }

  const supabase = await staffClient();

  // The class must exist and be one this staff member can see. Read through the
  // ordinary client so the policy is the check, not a condition written here.
  const { data: session } = await supabase
    .from('live_sessions')
    .select('id')
    .eq('id', parsed.data.sessionId)
    .maybeSingle();
  if (!session) return { ok: false, error: 'sessionNotFound' };

  const { count } = await supabase
    .from('live_slides')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', parsed.data.sessionId);
  const room = MAX_SLIDES - (count ?? 0);
  if (room <= 0) return { ok: false, error: 'deckFull' };

  const accepted = parsed.data.pages.slice(0, room);
  const tickets = await Promise.all(
    accepted.map(async (page) => {
      const extension =
        page.contentType === 'image/png'
          ? 'png'
          : page.contentType === 'image/webp'
            ? 'webp'
            : 'jpg';
      // A page of a hashed PDF is filed once, under the deck, so another class
      // attaches it instead of uploading it again.
      const key = page.fingerprint
        ? deckKey(page.fingerprint, extension, slideName())
        : slideKey(parsed.data.sessionId, extension, slideName());
      const url = await signUpload(key, page.contentType);
      return url ? { key, url, contentType: page.contentType } : null;
    }),
  );
  if (tickets.some((ticket) => ticket === null)) {
    return { ok: false, error: 'storageUnavailable' };
  }

  return {
    ok: true,
    tickets: tickets as UploadTicket[],
    skipped: parsed.data.pages.length - accepted.length,
  };
}

const batchConfirmSchema = z.object({
  sessionId: z.string().uuid(),
  uploads: z
    .array(z.object({ key: z.string().max(300), filename: z.string().max(300).default('') }))
    .min(1)
    .max(MAX_BATCH),
});

export interface ConfirmedSlide {
  id: string;
  url: string | null;
  filename: string;
}

export interface ConfirmBatchResult extends AdminState {
  /** The rows that now exist, in the order they were sent. */
  slides?: ConfirmedSlide[];
  /** Uploads that did not become slides, each with the reason. */
  failed?: { key: string; error: string; detail?: string }[];
}

/**
 * Turn a batch of finished uploads into slides.
 *
 * The bytes are still the judge — every object's head is read back and sniffed
 * before a row exists — but the reads happen together and the rows go in with
 * one statement, so a page costs one PUT and a fraction of a round trip rather
 * than three of them. A page that fails is deleted and named; the rest land.
 */
export async function confirmSlides(input: {
  sessionId: string;
  uploads: { key: string; filename: string }[];
}): Promise<ConfirmBatchResult> {
  if (!r2Configured) return { ok: false, error: 'storageUnavailable' };

  const parsed = batchConfirmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid' };
  const { sessionId, uploads } = parsed.data;

  // Before anything reaches the bucket: is this a key we would have issued for
  // this class? A caller naming another class's object stops here.
  if (uploads.some((upload) => !isSlideKeyFor(upload.key, sessionId) && !isDeckKey(upload.key))) {
    return { ok: false, error: 'invalid' };
  }

  const supabase = await staffClient();

  const failed: { key: string; error: string; detail?: string }[] = [];
  const good: { key: string; filename: string; size: number; contentType: string }[] = [];
  /** Rejected objects, deleted after the response — never on the upload's path. */
  const rejected: string[] = [];

  const heads = await Promise.all(uploads.map((upload) => readObjectHead(upload.key)));
  for (let i = 0; i < uploads.length; i += 1) {
    const upload = uploads[i] as { key: string; filename: string };
    const object = heads[i];
    if (!object || !object.ok) {
      // The evidence, not our reading of it: a bucket that refused to answer
      // and an object that never landed are not the same failure.
      failed.push({ key: upload.key, error: 'uploadFailed', detail: object?.detail });
      continue;
    }
    if (object.size > MAX_IMAGE_BYTES) {
      rejected.push(upload.key);
      failed.push({ key: upload.key, error: 'tooLarge' });
      continue;
    }
    const check = checkImage(object.head);
    if (!check.ok) {
      rejected.push(upload.key);
      failed.push({ key: upload.key, error: check.error });
      continue;
    }
    good.push({
      key: upload.key,
      filename: safeFilename(upload.filename),
      size: object.size,
      contentType: check.contentType,
    });
  }

  // The cleanup is a side effect: the answer above is already decided, and a
  // slow or unreachable bucket must not hold the batch behind it.
  if (rejected.length > 0) {
    after(async () => {
      await Promise.allSettled(rejected.map((key) => deleteObject(key)));
    });
  }

  if (good.length === 0) {
    return { ok: false, error: failed[0]?.error ?? 'uploadFailed', failed };
  }

  const { data: last } = await supabase
    .from('live_slides')
    .select('display_order')
    .eq('session_id', sessionId)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const base = (last?.display_order ?? -1) + 1;

  const { data: rows, error } = await supabase
    .from('live_slides')
    .insert(
      good.map((item, index) => ({
        session_id: sessionId,
        storage_key: item.key,
        filename: item.filename,
        mime_type: item.contentType,
        byte_size: item.size,
        display_order: base + index,
      })),
    )
    .select('id, storage_key, filename');
  if (error || !rows) {
    reportError('slides.insert', error, { sessionId, count: good.length });
    await Promise.allSettled(good.map((item) => deleteObject(item.key)));
    return {
      ok: false,
      error: 'saveFailed',
      detail: error ? errorDetail(error) : 'no row returned',
      failed,
    };
  }

  // Matched by key rather than by row order: the rows are the caller's pages in
  // the order they were sent, and the deck must keep that order.
  const byKey = new Map(rows.map((row) => [row.storage_key, row]));
  const ordered = good
    .map((item) => byKey.get(item.key))
    .filter((row): row is { id: string; storage_key: string; filename: string } => row !== undefined);
  const urls = await Promise.all(ordered.map((row) => signDownload(row.storage_key)));

  revalidatePath('/[locale]/admin/live/[id]', 'page');

  return {
    ok: true,
    slides: ordered.map((row, i) => ({
      id: row.id,
      url: urls[i] ?? null,
      filename: row.filename,
    })),
    failed: failed.length > 0 ? failed : undefined,
  };
}

// ---------------------------------------------------------------------------
// Shared decks — a PDF rendered once, attached to every class that uses it
// ---------------------------------------------------------------------------

export interface CatalogPage {
  key: string;
  filename: string;
  mimeType: string;
  byteSize: number;
}

/**
 * Does this PDF's rendering already exist?
 *
 * `supported` is false when the migration has not been applied yet: the caller
 * then uses the old session-scoped keys, which the database still accepts, so
 * a deploy that lands before the SQL keeps uploading slides rather than
 * refusing them all.
 */
export async function lookupDeck(
  fingerprint: string,
): Promise<{ known: boolean; supported: boolean }> {
  const parsed = FINGERPRINT.safeParse(fingerprint);
  if (!parsed.success) return { known: false, supported: false };

  const supabase = await staffClient();
  const { data, error } = await supabase
    .from('deck_catalog')
    .select('fingerprint')
    .eq('fingerprint', parsed.data)
    .maybeSingle();
  if (error) {
    reportError('slides.lookupDeck', error, { fingerprint: parsed.data });
    return { known: false, supported: false };
  }
  return { known: Boolean(data), supported: true };
}

/**
 * Attach an already-rendered deck to this session.
 *
 * Rows only: the objects are the deck's, and this session's `live_slides`
 * points at them. Nothing is copied and nothing is uploaded, which is the
 * whole point — the second class to use a 400-page PDF waits a second, not
 * five minutes.
 */
export async function attachDeck(input: {
  sessionId: string;
  fingerprint: string;
}): Promise<ConfirmBatchResult> {
  const parsed = z
    .object({ sessionId: z.string().uuid(), fingerprint: FINGERPRINT })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();

  const { data: catalog, error } = await supabase
    .from('deck_catalog')
    .select('pages')
    .eq('fingerprint', parsed.data.fingerprint)
    .maybeSingle();
  if (error || !catalog) return { ok: false, error: 'invalid' };

  const pages = catalog.pages as unknown as CatalogPage[];
  if (!Array.isArray(pages) || pages.length === 0) return { ok: false, error: 'invalid' };

  const { data: last } = await supabase
    .from('live_slides')
    .select('display_order')
    .eq('session_id', parsed.data.sessionId)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const base = (last?.display_order ?? -1) + 1;

  const { data: rows, error: insertError } = await supabase
    .from('live_slides')
    .insert(
      pages.map((page, index) => ({
        session_id: parsed.data.sessionId,
        storage_key: page.key,
        filename: safeFilename(page.filename),
        mime_type: page.mimeType,
        byte_size: page.byteSize,
        display_order: base + index,
      })),
    )
    .select('id, storage_key, filename');
  if (insertError || !rows) {
    reportError('slides.attachDeck', insertError ?? new Error('no rows'), {
      sessionId: parsed.data.sessionId,
    });
    return {
      ok: false,
      error: 'saveFailed',
      detail: insertError ? errorDetail(insertError) : 'no row returned',
    };
  }

  const byKey = new Map(rows.map((row) => [row.storage_key, row]));
  const ordered = pages
    .map((page) => byKey.get(page.key))
    .filter((row): row is { id: string; storage_key: string; filename: string } => row !== undefined);
  const urls = await Promise.all(ordered.map((row) => signDownload(row.storage_key)));

  revalidatePath('/[locale]/admin/live/[id]', 'page');

  return {
    ok: true,
    slides: ordered.map((row, i) => ({
      id: row.id,
      url: urls[i] ?? null,
      filename: row.filename,
    })),
  };
}

/** Record a freshly rendered deck so the next class can attach it. */
export async function registerDeck(input: {
  fingerprint: string;
  pages: CatalogPage[];
}): Promise<AdminState> {
  const parsed = z
    .object({
      fingerprint: FINGERPRINT,
      pages: z
        .array(
          z.object({
            key: z.string().max(300),
            filename: z.string().max(300).default(''),
            mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
            byteSize: z.coerce.number().int().min(1).max(MAX_IMAGE_BYTES),
          }),
        )
        .min(1)
        .max(500),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid' };

  if (parsed.data.pages.some((page) => !isDeckKey(page.key))) {
    return { ok: false, error: 'invalid' };
  }

  const supabase = await staffClient();
  const { error } = await supabase.from('deck_catalog').upsert(
    {
      fingerprint: parsed.data.fingerprint,
      page_count: parsed.data.pages.length,
      pages: parsed.data.pages.map((page) => ({
        key: page.key,
        filename: safeFilename(page.filename),
        mimeType: page.mimeType,
        byteSize: page.byteSize,
      })),
    },
    { onConflict: 'fingerprint', ignoreDuplicates: true },
  );
  if (error) {
    reportError('slides.registerDeck', error, { fingerprint: parsed.data.fingerprint });
    return { ok: false, error: 'saveFailed', detail: errorDetail(error) };
  }
  return OK;
}

const removeSchema = z.object({ id: z.string().uuid(), sessionId: z.string().uuid() });

/**
 * Remove one slide from a deck.
 *
 * The preparation screen and the room both come through here: the same staff
 * gate, the same key read back through the policy, the same object cleanup.
 * The room calls it directly, mid-lesson; `deleteSlide` below is the
 * form-shaped wrapper the admin screen's `useActionState` uses.
 */
export async function removeSlide(input: { id: string; sessionId: string }): Promise<AdminState> {
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();

  // Read the key back through the policy rather than taking it from the form:
  // the row is what says which object this slide owns.
  const { data: slide } = await supabase
    .from('live_slides')
    .select('storage_key, session_id')
    .eq('id', parsed.data.id)
    .maybeSingle();
  if (!slide || slide.session_id !== parsed.data.sessionId) {
    return { ok: false, error: 'invalid' };
  }

  const { error } = await supabase.from('live_slides').delete().eq('id', parsed.data.id);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  // The row is gone, so the slide is already unreachable; a bucket object that
  // outlives its row is waste, not an exposure, and a failed delete is logged
  // rather than shown to the teacher as a failure to remove the slide.
  //
  // The delete runs AFTER the response. A teacher removing a page mid-lesson
  // must not be held by a bucket round trip, and a bucket that never answers
  // must not leave the button spinning — which is exactly what it used to do.
  //
  // A shared deck's objects are NOT deleted: another class points at the same
  // bytes. Removing the slide from this session means removing the row.
  if (slide.storage_key.startsWith('live/')) {
    const key = slide.storage_key;
    after(async () => {
      await deleteObject(key);
    });
  }

  revalidatePath('/[locale]/admin/live/[id]', 'page');
  return OK;
}

export async function deleteSlide(_prev: AdminState, formData: FormData): Promise<AdminState> {
  return removeSlide({
    id: String(formData.get('id') ?? ''),
    sessionId: String(formData.get('sessionId') ?? ''),
  });
}

/** Move one slide up or down the deck, swapping with its neighbour. */
export async function moveSlide(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({
      id: z.string().uuid(),
      sessionId: z.string().uuid(),
      direction: z.enum(['up', 'down']),
    })
    .safeParse({
      id: formData.get('id'),
      sessionId: formData.get('sessionId'),
      direction: formData.get('direction'),
    });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();
  const { data: deck } = await supabase
    .from('live_slides')
    .select('id, display_order')
    .eq('session_id', parsed.data.sessionId)
    .order('display_order');
  if (!deck) return { ok: false, error: 'saveFailed' };

  const at = deck.findIndex((s) => s.id === parsed.data.id);
  const to = parsed.data.direction === 'up' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= deck.length) return OK; // Already at the end.

  // Swap the two orders. Two updates rather than a renumber of the whole deck:
  // the pair is what changed, and `display_order` carries no uniqueness that a
  // transient collision could violate.
  const a = deck[at];
  const b = deck[to];
  if (!a || !b) return OK;
  const { error } = await supabase
    .from('live_slides')
    .update({ display_order: b.display_order })
    .eq('id', a.id);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };
  await supabase.from('live_slides').update({ display_order: a.display_order }).eq('id', b.id);

  revalidatePath('/[locale]/admin/live/[id]', 'page');
  return OK;
}

export interface ClearDeckResult extends AdminState {
  /** How many slides were removed. */
  removed?: number;
}

/**
 * Empty a class's deck.
 *
 * The rows first, then the objects: a slide with no row is already invisible to
 * every read path, so a bucket delete that fails leaves waste rather than
 * exposure. The keys are read before the delete because after it there is
 * nothing left to name them.
 */
export async function clearSlides(sessionId: string): Promise<ClearDeckResult> {
  const parsed = z.string().uuid().safeParse(sessionId);
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await staffClient();

  const { data: rows, error: readError } = await supabase
    .from('live_slides')
    .select('storage_key')
    .eq('session_id', parsed.data);
  if (readError) return { ok: false, error: 'saveFailed', detail: errorDetail(readError) };

  // Only this session's own objects. A shared deck's pages are the same bytes
  // for every class using it, and clearing one class's deck must not blank
  // another's.
  const keys = (rows ?? [])
    .map((row) => row.storage_key)
    .filter((key) => key.startsWith('live/'));

  const { error } = await supabase.from('live_slides').delete().eq('session_id', parsed.data);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  // After the response, and a handful at a time: a deck can hold hundreds of
  // pages, and a hundred simultaneous deletes is its own way of hanging. The
  // count comes from the answers rather than from rejected promises —
  // `deleteObject` answers false instead of throwing, so the old
  // `allSettled` count could only ever have been zero.
  after(async () => {
    let stranded = 0;
    await runPool(keys, 8, async (key) => {
      if (!(await deleteObject(key))) stranded += 1;
    });
    if (stranded > 0) {
      reportError('slides.clearObjects', new Error(`${stranded} objects not deleted`), {
        sessionId: parsed.data,
      });
    }
  });

  revalidatePath('/[locale]/admin/live/[id]', 'page');
  return { ok: true, removed: keys.length };
}

/** The form-shaped wrapper the preparation screen's `useActionState` uses. */
export async function deleteAllSlides(_prev: AdminState, formData: FormData): Promise<AdminState> {
  return clearSlides(String(formData.get('sessionId') ?? ''));
}
