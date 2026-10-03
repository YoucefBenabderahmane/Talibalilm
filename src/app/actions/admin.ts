'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { parseVideoRef, resolveVideoUpdate, type VideoProvider } from '@/lib/content/video';
import { deleteObject } from '@/lib/storage/r2';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { requireStaff } from '@/lib/auth/guards';
import { CATALOGUE_TAG } from '@/lib/data/cache-tags';
import { pickFreeSlug, slugify } from '@/lib/content/slug';
import { highlightsToJson, parseBullets, parseHighlights } from '@/lib/content/presentation';
import { errorDetail } from '@/lib/supabase/error-detail';

/**
 * Course-builder mutations.
 *
 * Each one re-establishes staff identity and then writes through the ordinary
 * anon-key client, so the `is_staff()` policies apply. The service-role client
 * is deliberately not used here: an authoring screen has no business bypassing
 * the rules it is authoring under.
 */
export interface AdminState {
  ok: boolean;
  error?: string;
  /**
   * What the database actually said, verbatim, for an ADMIN screen only.
   *
   * Every `error` above is a key we chose, which means it is our diagnosis of
   * the failure rather than the failure itself. That is right for a student —
   * they cannot act on a PostgREST error code and should not be shown one. It
   * is wrong for the office: the coupon generator spent days reporting a
   * confident guess about which migration was missing while the one string
   * that would have identified the real cause went to a server log nobody was
   * going to fetch.
   *
   * So an admin gets both: the sentence, and underneath it the code, message
   * and hint exactly as Postgres phrased them. These screens are already
   * behind `requireAdmin()`, and an admin who can grant entitlements can
   * certainly be shown an error code.
   */
  detail?: string;
  /**
   * The `name` of the input that caused a validation failure.
   *
   * The form uses it to put the cursor in the offending box and scroll it into
   * view. Without it, a long form that refuses tells the office "invalid" and
   * leaves them hunting for which of fifteen fields it meant — and the reflex
   * is to start over, which throws away everything they had typed.
   */
  field?: string;
}

const OK: AdminState = { ok: true };

/**
 * The public catalogue changed.
 *
 * `revalidatePath` clears the admin screens; `revalidateTag` is what the
 * public pages listen to — the cached readers in `@/lib/data/courses` and
 * `@/lib/data/commerce` carry `CATALOGUE_TAG`, and without this an edit would
 * wait out the five-minute backstop before appearing on `/` or a module page.
 */
function revalidateCatalogue(): void {
  revalidateTag(CATALOGUE_TAG);
}

async function client() {
  if (!supabaseConfigured) throw new Error('unavailable');
  await requireStaff();
  return createClient();
}

const courseSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(2).max(200),
  subtitle: z.string().max(300).default(''),
  description: z.string().max(8000).default(''),
  title_ar: z.string().max(200).default(''),
  category: z.string().max(40).default('fiqh'),
  level: z.enum(['all', 'beginner', 'intermediate', 'advanced']).default('all'),
  format: z.enum(['presentiel', 'visio', 'hybride']).default('hybride'),
  tone: z.string().max(20).default('emerald'),
  schedule: z.string().max(200).default(''),
  duration_weeks: z.coerce.number().int().min(0).max(200).default(0),

  // What the module's page says about itself. The office types these as lines
  // in a textarea; the column stores JSON, and the parsers are pure and tested
  // so a stray character in the box cannot reach a `.map()` on the public page.
  department: z.string().max(200).default(''),
  department_body: z.string().max(4000).default(''),
  requirements: z.string().max(4000).default('').transform(parseBullets),
  highlights: z.string().max(4000).default('').transform(parseHighlights),

  /**
   * What the footer's save meant: keep it a draft, or publish it.
   *
   * One action rather than two, so the module and its status cannot end up
   * half-applied — a saved draft that was meant to be published is a module
   * nobody can find, and the office has no way to tell it happened.
   */
  intent: z.enum(['draft', 'publish']).optional(),
});

export async function createCourse(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const title = String(formData.get('title') ?? '');
  const parsed = courseSchema.safeParse({ title });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await client();
  // The address is derived from the title, here, once. Two courses may share a
  // title, so the free one in the series is taken rather than failing the save.
  const base = slugify(parsed.data.title, 72);
  const { data: siblings } = await supabase
    .from('courses')
    .select('slug')
    .like('slug', `${base || 'cours'}%`);
  const slug = pickFreeSlug(
    base,
    (siblings ?? []).map((r) => r.slug),
  );

  const { data, error } = await supabase
    .from('courses')
    .insert({ title: parsed.data.title, slug })
    .select('id')
    .single();

  if (error)
    return {
      ok: false,
      error: error.code === '23505' ? 'duplicate' : 'refused',
      detail: errorDetail(error),
    };

  revalidatePath('/admin/courses', 'layout');
  revalidateCatalogue();
  redirect(`/admin/courses/${data.id}`);
}

export interface FillState {
  ok: boolean;
  error?: string;
  /** What to write into the form; the office reviews it before saving. */
  title?: string;
  content?: string;
  videoId?: string;
}

/**
 * Fill a lesson from its video link.
 *
 * The office pastes a link; this asks the video's own metadata what it is
 * called and writes the title, the type and a content line. YouTube's oEmbed
 * endpoint is free, needs no key, and returns the title and the channel —
 * Drive publishes no such endpoint, so there the link's own filename is the
 * best there is. Nothing is saved here: the values go back to the form, where
 * the office can change them before pressing save.
 */
export async function fillLessonFromVideo(url: string): Promise<FillState> {
  await requireStaff();

  const parsed = z.string().trim().min(4).max(500).safeParse(url);
  if (!parsed.success) return { ok: false, error: 'videoUnrecognised' };

  const ref = parseVideoRef(parsed.data);
  if (ref.provider === 'none' || !ref.id) return { ok: false, error: 'videoUnrecognised' };

  let title: string | null = null;
  let author: string | null = null;

  if (ref.provider === 'youtube') {
    try {
      const response = await fetch(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(parsed.data)}`,
        { cache: 'no-store' },
      );
      if (response.ok) {
        const body = (await response.json()) as { title?: string; author_name?: string };
        title = body.title?.trim() || null;
        author = body.author_name?.trim() || null;
      }
    } catch (cause) {
      // The link is still usable; only the automatic title is lost.
      console.error('[admin] oEmbed lookup failed:', cause instanceof Error ? cause.message : cause);
    }
  } else if (ref.provider === 'drive') {
    const fromUrl = parsed.data.match(/\/([^/?#]+?)(?:\.(?:mp4|webm|mov))?(?:[?#]|$)/);
    title = fromUrl?.[1] ? decodeURIComponent(fromUrl[1]).replace(/[_-]+/g, ' ') : null;
  }

  const lines = [title, author ? `${author}` : null, parsed.data].filter(Boolean) as string[];

  return {
    ok: true,
    ...(title ? { title } : {}),
    content: lines.join('\n'),
    videoId: parsed.data,
  };
}

export async function updateCourse(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = courseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    // Name the field. `revalidatePath` is deliberately NOT called on this path:
    // re-rendering the route would reset every `defaultValue` and wipe what the
    // office had typed, which is the behaviour being fixed here.
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: 'invalid',
      field: first?.path[0] ? String(first.path[0]) : undefined,
    };
  }
  if (!parsed.data.id) return { ok: false, error: 'invalid' };

  // `slug` is deliberately absent from the schema: the address is settled at
  // creation and kept, so renaming a course does not break the links to it.
  const { id, highlights, intent, ...fields } = parsed.data;
  const supabase = await client();
  const { error } = await supabase
    .from('courses')
    .update({
      ...fields,
      highlights: highlightsToJson(highlights),
      // The footer's choice travels with the save when it made one.
      ...(intent ? { status: intent === 'publish' ? 'published' : 'draft' } : {}),
      ...(intent === 'publish' ? { published_at: new Date().toISOString() } : {}),
    })
    .eq('id', id);
  if (error)
    return {
      ok: false,
      error: error.code === '23505' ? 'duplicate' : 'refused',
      detail: errorDetail(error),
    };

  revalidatePath('/admin/courses', 'layout');
  revalidatePath('/courses', 'layout');
  revalidateCatalogue();
  return OK;
}

export async function setCourseStatus(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({ id: z.string().uuid(), status: z.enum(['draft', 'published', 'archived']) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await client();
  // `published_at` is required by a check constraint once status is published,
  // and is set here rather than by a trigger so re-publishing keeps the
  // original date visible to the editor.
  const { error } = await supabase
    .from('courses')
    .update({
      status: parsed.data.status,
      ...(parsed.data.status === 'published' ? { published_at: new Date().toISOString() } : {}),
    })
    .eq('id', parsed.data.id);

  if (error) return { ok: false, error: 'refused', detail: errorDetail(error) };

  revalidatePath('/admin/courses', 'layout');
  revalidatePath('/courses', 'layout');
  revalidateCatalogue();
  return OK;
}

export async function deleteCourse(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await client();
  const { error } = await supabase.from('courses').delete().eq('id', parsed.data.id);
  if (error) return { ok: false, error: 'refused', detail: errorDetail(error) };

  revalidatePath('/admin/courses', 'layout');
  revalidateCatalogue();
  redirect('/admin/courses');
}

/* ---- Modules ---------------------------------------------------------- */

export async function addModule(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({ courseId: z.string().uuid(), title: z.string().min(1).max(200) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await client();
  const { data: existing } = await supabase
    .from('modules')
    .select('position')
    .eq('course_id', parsed.data.courseId)
    .order('position', { ascending: false })
    .limit(1);

  const nextPosition = (existing?.[0]?.position ?? 0) + 1;
  const { error } = await supabase
    .from('modules')
    .insert({ course_id: parsed.data.courseId, title: parsed.data.title, position: nextPosition });

  if (error) return { ok: false, error: 'refused', detail: errorDetail(error) };
  revalidatePath('/admin/courses', 'layout');
  revalidateCatalogue();
  return OK;
}

export async function renameModule(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({ id: z.string().uuid(), title: z.string().min(1).max(200) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await client();
  const { error } = await supabase
    .from('modules')
    .update({ title: parsed.data.title })
    .eq('id', parsed.data.id);

  if (error) return { ok: false, error: 'refused', detail: errorDetail(error) };
  revalidatePath('/admin/courses', 'layout');
  revalidateCatalogue();
  return OK;
}

export async function deleteModule(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await client();
  const { error } = await supabase.from('modules').delete().eq('id', parsed.data.id);
  if (error) return { ok: false, error: 'refused', detail: errorDetail(error) };
  revalidatePath('/admin/courses', 'layout');
  revalidateCatalogue();
  return OK;
}

/**
 * Swap two rows' positions.
 *
 * `(course_id, position)` is unique, so a naive two-step update collides
 * mid-flight. The constraint is `deferrable initially deferred`, which lets
 * both writes land inside one statement and be checked at commit — hence the
 * single RPC-shaped update rather than two round trips.
 */
async function swapPositions(
  table: 'modules' | 'lessons',
  a: { id: string; position: number },
  b: { id: string; position: number },
): Promise<AdminState> {
  const supabase = await client();
  const { error: firstError } = await supabase
    .from(table)
    .update({ position: b.position })
    .eq('id', a.id);
  if (firstError) return { ok: false, error: 'refused', detail: errorDetail(firstError) };

  const { error: secondError } = await supabase
    .from(table)
    .update({ position: a.position })
    .eq('id', b.id);
  if (secondError) return { ok: false, error: 'refused', detail: errorDetail(secondError) };

  revalidatePath('/admin/courses', 'layout');
  revalidateCatalogue();
  return OK;
}

export async function moveModule(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({
      id: z.string().uuid(),
      position: z.coerce.number().int(),
      otherId: z.string().uuid(),
      otherPosition: z.coerce.number().int(),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: 'invalid' };

  return swapPositions(
    'modules',
    { id: parsed.data.id, position: parsed.data.position },
    { id: parsed.data.otherId, position: parsed.data.otherPosition },
  );
}

export async function moveLesson(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({
      id: z.string().uuid(),
      position: z.coerce.number().int(),
      otherId: z.string().uuid(),
      otherPosition: z.coerce.number().int(),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: 'invalid' };

  return swapPositions(
    'lessons',
    { id: parsed.data.id, position: parsed.data.position },
    { id: parsed.data.otherId, position: parsed.data.otherPosition },
  );
}

/* ---- Lessons ---------------------------------------------------------- */

export async function addLesson(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({ moduleId: z.string().uuid(), title: z.string().min(1).max(200) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await client();
  const { data: existing } = await supabase
    .from('lessons')
    .select('position')
    .eq('module_id', parsed.data.moduleId)
    .order('position', { ascending: false })
    .limit(1);

  const nextPosition = (existing?.[0]?.position ?? 0) + 1;
  const { data, error } = await supabase
    .from('lessons')
    .insert({
      module_id: parsed.data.moduleId,
      title: parsed.data.title,
      slug: slugify(parsed.data.title) || `lecon-${nextPosition}`,
      position: nextPosition,
    })
    .select('id')
    .single();

  if (error) return { ok: false, error: 'refused', detail: errorDetail(error) };

  // The 1:1 content row is created alongside so the editor always has
  // something to write into and the join never has to cope with a missing row.
  await supabase.from('lesson_content').insert({ lesson_id: data.id });

  revalidatePath('/admin/courses', 'layout');
  revalidateCatalogue();
  return OK;
}

export async function updateLesson(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z
    .object({
      id: z.string().uuid(),
      title: z.string().min(1).max(200),
      type: z.enum(['video', 'text', 'live', 'quiz', 'assignment']).default('video'),
      minutes: z.coerce.number().int().min(0).max(1440).default(0),
      is_preview: z.coerce.boolean().default(false),
      /** The group whose content is edited. Null when the module has no classes. */
      classId: z.string().uuid().nullable().catch(null),
      class_content: z.string().max(50000).default(''),
      class_video_id: z.string().max(200).default(''),
      /** The shared preview fields, present only when the lesson is a trial. */
      content: z.string().max(50000).optional(),
      video_id: z.string().max(200).optional(),
    })
    .safeParse({
      ...Object.fromEntries(formData),
      is_preview: formData.get('is_preview') === 'on',
    });
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await client();
  const { error: lessonError } = await supabase
    .from('lessons')
    .update({
      title: parsed.data.title,
      type: parsed.data.type,
      duration_seconds: parsed.data.minutes * 60,
      is_preview: parsed.data.is_preview,
    })
    .eq('id', parsed.data.id);

  if (lessonError) return { ok: false, error: 'refused', detail: errorDetail(lessonError) };

  // ---- The group's content -------------------------------------------------
  //
  // The row is read first because the link box is EMPTY for an uploaded video:
  // resolving the empty box on its own answered `none` and wrote it over the
  // upload on every save. `resolveVideoUpdate` owns that rule.
  if (parsed.data.classId) {
    const { data: current } = await supabase
      .from('class_lesson_content')
      .select('video_provider, video_id')
      .eq('lesson_id', parsed.data.id)
      .eq('class_id', parsed.data.classId)
      .maybeSingle();

    const video = resolveVideoUpdate(
      {
        provider: (current?.video_provider as VideoProvider | undefined) ?? 'none',
        id: current?.video_id ?? null,
      },
      parsed.data.class_video_id,
    );
    if (!video) return { ok: false, error: 'video_unrecognised' };

    // A link replacing an upload orphans the object unless it is removed here.
    if (current?.video_provider === 'r2' && current.video_id && video.provider !== 'r2') {
      await deleteObject(current.video_id);
    }

    const { error: classError } = await supabase.from('class_lesson_content').upsert(
      {
        lesson_id: parsed.data.id,
        class_id: parsed.data.classId,
        content: parsed.data.class_content,
        video_id: video.id,
        video_provider: video.provider,
      },
      { onConflict: 'class_id,lesson_id' },
    );
    // The check constraint rejects a URL in video_id; report that specifically
    // rather than as a generic failure, because it is a mistake an author makes.
    if (classError) {
      return {
        ok: false,
        error: classError.code === '23514' ? 'video_id_is_url' : 'refused',
        detail: errorDetail(classError),
      };
    }
  }

  // ---- The shared row, for a public preview ---------------------------------
  //
  // Absent fields mean "not edited": a regular lesson's form does not carry
  // them, and upserting with defaults would blank a trial's content.
  if (parsed.data.content !== undefined || parsed.data.video_id !== undefined) {
    const { data: currentContent } = await supabase
      .from('lesson_content')
      .select('video_provider, video_id')
      .eq('lesson_id', parsed.data.id)
      .maybeSingle();

    const video = resolveVideoUpdate(
      {
        provider: (currentContent?.video_provider as VideoProvider | undefined) ?? 'none',
        id: currentContent?.video_id ?? null,
      },
      parsed.data.video_id ?? '',
    );
    if (!video) return { ok: false, error: 'video_unrecognised' };

    if (
      currentContent?.video_provider === 'r2' &&
      currentContent.video_id &&
      video.provider !== 'r2'
    ) {
      await deleteObject(currentContent.video_id);
    }

    const { error: contentError } = await supabase.from('lesson_content').upsert(
      {
        lesson_id: parsed.data.id,
        content: parsed.data.content ?? '',
        video_id: video.id,
        video_provider: video.provider,
      },
      { onConflict: 'lesson_id' },
    );

    if (contentError) {
      return { ok: false, error: contentError.code === '23514' ? 'video_id_is_url' : 'refused' };
    }
  }

  revalidatePath('/admin/courses', 'layout');
  revalidatePath('/courses', 'layout');
  revalidateCatalogue();
  return OK;
}

export async function deleteLesson(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: 'invalid' };

  const supabase = await client();
  const { error } = await supabase.from('lessons').delete().eq('id', parsed.data.id);
  if (error) return { ok: false, error: 'refused', detail: errorDetail(error) };
  revalidatePath('/admin/courses', 'layout');
  revalidateCatalogue();
  return OK;
}
