import { cookies } from 'next/headers';
import { z } from 'zod';

/**
 * What the student has chosen so far, carried between the checkout steps.
 *
 * It lives in a cookie rather than a database row, and it is deliberately NOT
 * signed. Nothing here is trusted: the cookie holds ids, and every step reads
 * those ids back out of the catalogue and prices them server-side. The worst a
 * tampered cookie can do is select a different published product — which is
 * what the buttons on the page do anyway.
 *
 * The thing that must never appear in here is an amount.
 */
export const selectionSchema = z.object({
  cursusId: z.string().uuid().nullable().default(null),
  kind: z.enum(['module', 'approfondi']).nullable().default(null),
  delivery: z.enum(['presentiel', 'online']).nullable().default(null),
  yearIndex: z.number().int().min(1).max(10).default(1),
  productIds: z.array(z.string().uuid()).max(20).default([]),
  /**
   * The module a student arrived wanting, before a delivery mode is known.
   *
   * A product belongs to one mode, so "this module" cannot be a product id
   * until the mode step is answered. Holding the COURSE lets the enrol button
   * on a module page skip the cursus step without pre-answering the mode
   * question on the student's behalf.
   */
  courseId: z.string().uuid().nullable().default(null),
  couponCode: z.string().max(32).nullable().default(null),
  /**
   * How many payments the student is spreading this over. 1 is the ordinary
   * single payment; 3 is the plan the school offers. The split itself is
   * computed server-side from the priced total, never from here.
   */
  installments: z.number().int().min(1).max(3).default(1),
});

export type Selection = z.infer<typeof selectionSchema>;

export const EMPTY_SELECTION: Selection = {
  cursusId: null,
  kind: null,
  delivery: null,
  yearIndex: 1,
  productIds: [],
  courseId: null,
  couponCode: null,
  installments: 1,
};

const COOKIE = 'tal_checkout';
/** Long enough to read a programme and think about it, short enough to forget. */
const MAX_AGE_SECONDS = 60 * 60 * 4;

export async function readSelection(): Promise<Selection> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return EMPTY_SELECTION;

  try {
    const parsed = selectionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : EMPTY_SELECTION;
  } catch {
    // A malformed cookie is a fresh start, never an error page.
    return EMPTY_SELECTION;
  }
}

/** Only callable from a Server Action or a Route Handler. */
export async function writeSelection(selection: Selection): Promise<void> {
  (await cookies()).set(COOKIE, JSON.stringify(selection), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearSelection(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/**
 * How far the student has got, and therefore which step may be shown.
 *
 * Returned rather than checked at each page, so a deep link to step four with
 * an empty cookie sends the visitor back to step one instead of rendering a
 * form with nothing in it.
 */
export function furthestStep(selection: Selection): 1 | 2 | 3 | 4 {
  if (!selection.kind) return 1;
  if (!selection.delivery) return 2;
  if (selection.productIds.length === 0) return 3;
  return 4;
}

/**
 * The selection after a route card is pressed.
 *
 * Choosing a different route — or a different cursus — starts the downstream
 * answers over: the mode, the year and the products belong to the route that
 * was chosen before, and keeping them would price a basket the student can no
 * longer see.
 *
 * The subtle half is the comparison. A module and a not-yet-chosen approfondi
 * both carry `cursusId = null` (the approfondi is waiting for its programme),
 * so comparing the cursus alone would keep a module's basket when the student
 * switches to the approfondi route. The KIND has to match too.
 */
export function afterCursusChoice(
  current: Selection,
  choice: { kind: 'module' | 'approfondi'; cursusId: string | null; courseId: string | null },
): Selection {
  // An approfondi is a cursus, not a module: whatever module page the student
  // was reading, it must not stay pinned to it.
  const courseId = choice.kind === 'approfondi' ? null : choice.courseId;
  const sameRoute = current.kind === choice.kind && current.cursusId === choice.cursusId;
  return sameRoute
    ? { ...current, ...choice, courseId }
    : { ...EMPTY_SELECTION, ...choice, courseId };
}
