'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { requireStaff } from '@/lib/auth/guards';
import { checkImage, MAX_IMAGE_BYTES } from '@/lib/media/image';
import { isSlideKeyFor, safeFilename, slideKey, slideName } from '@/lib/storage/key';
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
const MAX_SLIDES = 200;
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

const batchRequestSchema = z.object({
  sessionId: z.string().uuid(),
  pages: z
    .array(
      z.object({
        // The declared type decides the extension only. It is not believed: the
        // bytes are read back in `confirmSlides` before any slide exists.
        contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        byteSize: z.coerce.number().int().min(1).max(MAX_IMAGE_BYTES),
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
  pages: { contentType: string; byteSize: number }[];
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
      const key = slideKey(parsed.data.sessionId, extension, slideName());
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
  if (uploads.some((upload) => !isSlideKeyFor(upload.key, sessionId))) {
    return { ok: false, error: 'invalid' };
  }

  const supabase = await staffClient();

  const failed: { key: string; error: string; detail?: string }[] = [];
  const good: { key: string; filename: string; size: number; contentType: string }[] = [];

  const heads = await Promise.all(uploads.map((upload) => readObjectHead(upload.key)));
  for (let i = 0; i < uploads.length; i += 1) {
    const upload = uploads[i] as { key: string; filename: string };
    const object = heads[i];
    if (!object) {
      failed.push({ key: upload.key, error: 'uploadFailed' });
      continue;
    }
    if (object.size > MAX_IMAGE_BYTES) {
      await deleteObject(upload.key);
      failed.push({ key: upload.key, error: 'tooLarge' });
      continue;
    }
    const check = checkImage(object.head);
    if (!check.ok) {
      await deleteObject(upload.key);
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

/**
 * The deck as it stands, for a viewer already in the room.
 *
 * Called when the teacher adds slides mid-lesson: the room tells every browser
 * the deck changed, and each one reads it for itself. The URLs are minted per
 * caller through `can_read_slide()`, so a slide added during a class is
 * visible to the students entitled to it and to nobody else — which a URL
 * copied out of the teacher's page would not have been.
 */
export async function roomSlides(
  sessionId: string,
): Promise<{ id: string; url: string | null; filename: string }[]> {
  if (!supabaseConfigured) return [];
  if (!z.string().uuid().safeParse(sessionId).success) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('live_slides')
    .select('id, storage_key, filename')
    .eq('session_id', sessionId)
    .order('display_order');
  if (error) {
    reportError('slides.roomList', error, { sessionId });
    return [];
  }

  const rows = data ?? [];
  const urls = await Promise.all(rows.map((r) => slideUrl(r.storage_key)));
  return rows.map((r, i) => ({ id: r.id, url: urls[i] ?? null, filename: r.filename }));
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
  await deleteObject(slide.storage_key);

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

  const keys = (rows ?? []).map((row) => row.storage_key);

  const { error } = await supabase.from('live_slides').delete().eq('session_id', parsed.data);
  if (error) return { ok: false, error: 'saveFailed', detail: errorDetail(error) };

  const results = await Promise.allSettled(keys.map((key) => deleteObject(key)));
  const stranded = results.filter((result) => result.status === 'rejected').length;
  if (stranded > 0) {
    reportError('slides.clearObjects', new Error(`${stranded} objects not deleted`), {
      sessionId: parsed.data,
    });
  }

  revalidatePath('/[locale]/admin/live/[id]', 'page');
  return { ok: true, removed: keys.length };
}

/** The form-shaped wrapper the preparation screen's `useActionState` uses. */
export async function deleteAllSlides(_prev: AdminState, formData: FormData): Promise<AdminState> {
  return clearSlides(String(formData.get('sessionId') ?? ''));
}

/**
 * A signed link to one slide, for whoever is allowed to see it.
 *
 * `can_read_slide()` answers from the key alone, inside the database, so a
 * student cannot pass a session id that disagrees with the object they want.
 * Staff and entitled students get a URL; everyone else gets null, key in hand
 * or not.
 */
export async function slideUrl(key: string): Promise<string | null> {
  if (!supabaseConfigured || !r2Configured) return null;
  const supabase = await createClient();
  const { data: allowed, error } = await supabase.rpc('can_read_slide', { key });
  if (error) {
    reportError('slides.authorize', error);
    return null;
  }
  if (!allowed) return null;
  return signDownload(key);
}
