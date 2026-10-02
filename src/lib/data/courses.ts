import { unstable_cache } from 'next/cache';
import { createClient, createPublicClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { CATALOGUE_TAG, CATALOGUE_TTL } from '@/lib/data/cache-tags';
import { reportError } from '@/lib/observability/report';
import {
  courses as fixtureCourses,
  getCourse as getFixtureCourse,
  getInstructor as getFixtureInstructor,
  listCourses as listFixtureCourses,
} from '@/lib/content/courses';
import { readBullets, readGallery, readHighlights } from '@/lib/content/presentation';
import type { ArtTone, Course, CourseCategory, CourseLevel, Instructor } from '@/lib/content/types';
import type { CourseRow, LessonRow, ModuleRow } from '@/lib/supabase/database.types';

/**
 * Catalogue reads.
 *
 * When Supabase is configured this queries it; otherwise it serves the Phase 1
 * fixtures. That fallback is not laziness — it keeps the marketing site
 * deployable and demoable before the database exists, which is exactly the
 * state the project is in between phases. `usingFixtures()` reports which
 * source answered so the admin can say so plainly rather than showing an
 * empty catalogue that looks like a bug.
 *
 * Nothing here reads `lesson_content`. The gated fields are fetched only by
 * `getLessonContent`, and only ever server-side.
 */

/** Shape returned by the nested select below. */
interface NestedModule extends ModuleRow {
  lessons: LessonRow[];
}
interface NestedCourse extends CourseRow {
  modules: NestedModule[];
}

const COURSE_SELECT = `
  id, slug, title, subtitle, description, title_ar, cover_url, tone, category,
  level, format, language, instructor_id, status, published_at, display_order,
  schedule, duration_weeks, objectives, department, department_body,
  requirements, highlights, gallery, created_at, updated_at,
  modules ( id, course_id, title, position, created_at, updated_at,
    lessons ( id, module_id, title, slug, type, position, duration_seconds,
              is_preview, created_at, updated_at ) )
`;

const TONES: readonly ArtTone[] = [
  'emerald',
  'indigo',
  'plum',
  'sand',
  'crimson',
  'teal',
  'night',
];

/** The cover palette has seven colours; the column will hold anything. */
function asTone(value: unknown): ArtTone {
  return TONES.includes(value as ArtTone) ? (value as ArtTone) : 'emerald';
}

function toCourse(row: NestedCourse): Course {
  const objectives = Array.isArray(row.objectives)
    ? row.objectives.filter((o): o is string => typeof o === 'string')
    : [];

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    title_ar: row.title_ar,
    cover_url: row.cover_url,
    // Narrowed, not cast. `tone`, `category` and `level` are free `text` in
    // the schema with only a default to keep them sane, so a cast here is a
    // promise the database never made — and the components downstream index
    // records and translation catalogues with the result.
    tone: asTone(row.tone),
    category: row.category as CourseCategory,
    level: row.level as CourseLevel,
    format: row.format,
    language: row.language === 'ar' ? 'ar' : 'fr',
    instructor_id: row.instructor_id ?? '',
    status: row.status === 'published' ? 'published' : 'draft',
    published_at: row.published_at ?? row.created_at,
    display_order: row.display_order,
    schedule: row.schedule,
    duration_weeks: row.duration_weeks,
    objectives,
    department: row.department ?? '',
    department_body: row.department_body ?? '',
    requirements: readBullets(row.requirements),
    highlights: readHighlights(row.highlights),
    gallery: readGallery(row.gallery),
    modules: (row.modules ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((m) => ({
        id: m.id,
        title: m.title,
        position: m.position,
        lessons: (m.lessons ?? [])
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((l) => ({
            id: l.id,
            slug: l.slug,
            title: l.title,
            type: l.type,
            position: l.position,
            duration_seconds: l.duration_seconds,
            is_preview: l.is_preview,
          })),
      })),
  };
}

/** True when the catalogue came from fixtures rather than the database. */
export function usingFixtures(): boolean {
  return !supabaseConfigured;
}

/**
 * The published catalogue, cached across requests.
 *
 * Published courses are the same rows for everyone — that is what the policy
 * makes true — so this reads through `createPublicClient()` and is cached.
 * Reading through the cookie-bound client instead is what kept `/` and
 * `/courses` rendering on every request: `cookies()` opts a route out of
 * static rendering, and the catalogue was enough to do it.
 *
 * A query error is THROWN, not returned. `unstable_cache` stores whatever the
 * callback returns, so returning `[]` would turn a database blip into an
 * empty catalogue for the whole revalidate window. The wrapper below catches,
 * reports, and answers the same `[]` the uncached code did — without writing
 * the failure to the cache.
 */
const readCourses = unstable_cache(
  async (): Promise<Course[]> => {
    const supabase = createPublicClient();
    const { data, error } = await supabase
      .from('courses')
      .select(COURSE_SELECT)
      .eq('status', 'published')
      .order('display_order', { ascending: true });

    if (error) throw error;
    return (data as unknown as NestedCourse[]).map(toCourse);
  },
  ['courses-published'],
  { tags: [CATALOGUE_TAG], revalidate: CATALOGUE_TTL },
);

export async function listCourses(): Promise<Course[]> {
  if (!supabaseConfigured) return listFixtureCourses();

  // A query error against a configured database is an OUTAGE, not an empty
  // catalogue — and it must never fabricate courses. Serving the demo fixtures
  // here once real prices exist would let a customer open and try to buy a
  // course that does not exist. Report it and return nothing; the fixtures are
  // only for the pre-database state, which is `!supabaseConfigured` above.
  try {
    return await readCourses();
  } catch (error) {
    reportError('catalogue.list', error);
    return [];
  }
}

const readCourse = unstable_cache(
  async (slug: string): Promise<Course | undefined> => {
    const supabase = createPublicClient();
    const { data, error } = await supabase
      .from('courses')
      .select(COURSE_SELECT)
      .eq('slug', slug)
      .maybeSingle();

    if (error) throw error;
    return data ? toCourse(data as unknown as NestedCourse) : undefined;
  },
  ['course'],
  { tags: [CATALOGUE_TAG], revalidate: CATALOGUE_TTL },
);

export async function getCourse(slug: string): Promise<Course | undefined> {
  if (!supabaseConfigured) return getFixtureCourse(slug);

  try {
    return await readCourse(slug);
  } catch (error) {
    reportError('catalogue.get', error, { slug });
    return undefined;
  }
}

/**
 * Deliberately NOT cached, and on the cookie-bound client.
 *
 * `anon` holds no grant on `profiles`, so this answers differently depending
 * on who asks — a signed-in reader sees the teacher, an anonymous one does
 * not. A read whose answer depends on the reader is never cached and never
 * served from a cookie-free client.
 */
export async function getInstructor(id: string): Promise<Instructor | undefined> {
  if (!supabaseConfigured) return getFixtureInstructor(id);
  if (!id) return undefined;

  const supabase = await createClient();
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', id)
    .maybeSingle();

  if (!data) return undefined;
  return {
    id: data.id,
    full_name: data.full_name,
    role: data.role === 'admin' ? 'Direction' : 'Enseignant·e',
    bio: '',
  };
}

/**
 * What to read next: the same field first, then anything else.
 *
 * Two small queries rather than one read of the whole catalogue. The old
 * version loaded every published course with its modules and lessons just to
 * show three cards, on every view of every course page — the page crawlers
 * now find through the sitemap.
 */
const readRelated = unstable_cache(
  async (courseId: string, category: string, limit: number): Promise<Course[]> => {
    const supabase = createPublicClient();

    const sameField = await supabase
      .from('courses')
      .select(COURSE_SELECT)
      .eq('status', 'published')
      .eq('category', category)
      .neq('id', courseId)
      .order('display_order', { ascending: true })
      .limit(limit);
    if (sameField.error) throw sameField.error;

    const found = (sameField.data as unknown as NestedCourse[]).map(toCourse);
    if (found.length >= limit) return found;

    const rest = await supabase
      .from('courses')
      .select(COURSE_SELECT)
      .eq('status', 'published')
      .neq('category', category)
      .neq('id', courseId)
      .order('display_order', { ascending: true })
      .limit(limit - found.length);
    if (rest.error) throw rest.error;

    return [...found, ...(rest.data as unknown as NestedCourse[]).map(toCourse)];
  },
  ['related-courses'],
  { tags: [CATALOGUE_TAG], revalidate: CATALOGUE_TTL },
);

export async function relatedCourses(course: Course, limit = 3): Promise<Course[]> {
  if (!supabaseConfigured) {
    const others = listFixtureCourses().filter((c) => c.id !== course.id);
    const sameField = others.filter((c) => c.category === course.category);
    const rest = others.filter((c) => c.category !== course.category);
    return [...sameField, ...rest].slice(0, limit);
  }

  try {
    return await readRelated(course.id, course.category, limit);
  } catch (error) {
    reportError('catalogue.related', error, { courseId: course.id });
    return [];
  }
}

/** Slugs for `generateStaticParams`; fixtures at build time when there is no DB. */
export function buildTimeCourseSlugs(): string[] {
  return fixtureCourses.filter((c) => c.status === 'published').map((c) => c.slug);
}

export interface CoursePrice {
  delivery: 'presentiel' | 'online';
  priceCents: number;
  currency: string;
  durationDays: number;
}

/**
 * What this module costs, per mode.
 *
 * Read from `products` rather than from any constant: the currency belongs to
 * what is being sold, and a price the sales page invents is a price the
 * checkout will disagree with. Only published rows, so a draft tariff the
 * office is still working on never appears in front of a buyer.
 *
 * An empty list is a real answer — a module with no published price is not on
 * sale yet — and the panel says so instead of showing a confident zero.
 */
const readCoursePrices = unstable_cache(
  async (courseId: string): Promise<CoursePrice[]> => {
    const supabase = createPublicClient();
    const { data, error } = await supabase
      .from('products')
      .select('delivery, price_cents, currency, duration_days')
      .eq('kind', 'module')
      .eq('course_id', courseId)
      .eq('status', 'published')
      .order('delivery');

    if (error) throw error;
    return (data ?? []).map((row) => ({
      delivery: row.delivery,
      priceCents: row.price_cents,
      currency: row.currency,
      durationDays: row.duration_days,
    }));
  },
  ['course-prices'],
  { tags: [CATALOGUE_TAG], revalidate: CATALOGUE_TTL },
);

export async function coursePrices(courseId: string): Promise<CoursePrice[]> {
  if (!supabaseConfigured) return [];

  try {
    return await readCoursePrices(courseId);
  } catch (error) {
    reportError('courses.prices', error, { courseId });
    return [];
  }
}
