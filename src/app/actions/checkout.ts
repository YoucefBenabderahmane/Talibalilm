'use server';

import { z } from 'zod';
import { headers } from 'next/headers';
import {
  afterCursusChoice,
  EMPTY_SELECTION,
  readSelection,
  writeSelection,
} from '@/lib/commerce/selection';
import { listProducts } from '@/lib/data/commerce';
import { clientKey, rateLimit } from '@/lib/rate-limit';

/**
 * The checkout steps.
 *
 * Each action validates what it was handed and writes ids to the cookie. None
 * of them accepts a price, and none of them decides one — that is
 * `priceSelection`, run fresh on every render.
 *
 * None of them redirects either, and that is the point. The five steps are one
 * card on one page now; finishing a step must refresh what the card is showing
 * without taking the page out from under the reader. A Server Action already
 * re-renders the route it was called from, so returning is enough — the wizard
 * sees the new `furthest` and moves itself on.
 */

const kindSchema = z.object({
  kind: z.enum(['module', 'approfondi']),
  /**
   * The cursus, when the route names one. A module names none — it is sold on
   * its own whether or not any cursus lists it — and neither does an approfondi
   * whose programme the student has not chosen yet: the card is the same for
   * every Approfondi, and the choice is the step after it. Nothing can be paid
   * in that state (`loadBasket` finds no product), so the empty value is a
   * question still open, not a shortcut.
   */
  cursusId: z.string().uuid().nullable().catch(null),
  /**
   * Present on the module page's "Acheter ce module" card: the course is what
   * turns into a product once the mode is answered. The approfondi card sends
   * none, and the selection's courseId is cleared with it.
   */
  courseId: z.string().uuid().nullable().catch(null),
});

const deliverySchema = z.object({
  delivery: z.enum(['presentiel', 'online']),
  /**
   * Present when the card sits on a module's page. The module is then already
   * chosen, and the answer carries it so the action does not depend on a
   * previous click having written the cookie.
   */
  courseId: z.string().uuid().nullable().catch(null),
  cursusId: z.string().uuid().nullable().catch(null),
  kind: z.enum(['module', 'approfondi']).nullable().catch(null),
});

export async function chooseCursus(formData: FormData): Promise<void> {
  const parsed = kindSchema.safeParse({
    kind: formData.get('kind'),
    cursusId: formData.get('cursusId'),
    courseId: formData.get('courseId'),
  });
  if (!parsed.success) return;

  const current = await readSelection();
  // Changing route or cursus invalidates everything downstream; `afterCursusChoice`
  // owns that rule (and the module/approfondi distinction that makes it work).
  await writeSelection(afterCursusChoice(current, parsed.data));
}

export async function chooseDelivery(formData: FormData): Promise<void> {
  const parsed = deliverySchema.safeParse({
    delivery: formData.get('delivery'),
    courseId: formData.get('courseId'),
    cursusId: formData.get('cursusId'),
    kind: formData.get('kind'),
  });
  if (!parsed.success) return;

  const current = await readSelection();

  const kind = parsed.data.kind ?? current.kind;
  const cursusId = parsed.data.cursusId ?? current.cursusId;
  const courseId = parsed.data.courseId ?? current.courseId;

  // Prices and programmes are per delivery mode, so switching modes drops the
  // basket rather than carrying ids that belong to the other price list.
  let productIds = current.delivery === parsed.data.delivery ? current.productIds : [];

  // The enrol card on a module's page holds the COURSE, not a product, because
  // a product belongs to one mode. Now that the mode is answered, the course
  // becomes the matching product here — so the student does not then have to
  // find that same module in a list of everything the school sells. The id is
  // checked against the published price list first, exactly as a hand-posted
  // one would be.
  //
  // `courseId` stays on the selection: it is what tells the module's own page
  // that this basket belongs to it, and switching mode re-resolves it against
  // the other price list.
  if (kind === 'module' && courseId) {
    const offered = await listProducts(parsed.data.delivery);
    const match = offered.find((p) => p.kind === 'module' && p.courseId === courseId);
    if (match) productIds = [match.id];
  }

  await writeSelection({
    ...current,
    kind,
    cursusId,
    delivery: parsed.data.delivery,
    productIds,
    courseId,
  });
}

/**
 * Add or remove one module from the basket.
 *
 * The id is checked against the published price list for the chosen delivery
 * mode before it is stored, so a hand-posted id for a draft product — or for
 * the other mode's price — never reaches the quote.
 */
export async function toggleProduct(formData: FormData): Promise<void> {
  const productId = z.string().uuid().safeParse(formData.get('productId'));
  const selection = await readSelection();

  const { delivery } = selection;
  if (!productId.success || !delivery) return;

  const offered = await listProducts(delivery);
  const id = productId.data;
  if (!offered.some((p) => p.id === id)) return;

  const chosen = new Set(selection.productIds);
  if (chosen.has(id)) chosen.delete(id);
  else chosen.add(id);

  await writeSelection({ ...selection, productIds: [...chosen] });
}

/** The Approfondi route: one product, the year being enrolled in. */
export async function chooseCursusYear(formData: FormData): Promise<void> {
  const productId = z.string().uuid().safeParse(formData.get('productId'));
  const selection = await readSelection();

  const { delivery } = selection;
  if (!productId.success || !delivery) return;

  const offered = await listProducts(delivery);
  const product = offered.find((p) => p.id === productId.data);
  if (!product || product.kind !== 'cursus') return;

  await writeSelection({
    ...selection,
    productIds: [product.id],
    yearIndex: product.yearIndex,
  });
}

export interface CouponState {
  ok: boolean;
  /** Resolved by the form through next-intl. */
  error?: 'rateLimited' | 'invalid';
}

/**
 * Store a code, or say why not.
 *
 * The payment step reads the stored code back — read-only — to show what it
 * takes off, which makes applying one the way to probe for codes. The read
 * itself never spends anything; this cap is what keeps guessing slow. It says
 * so out loud now: returning nothing left the form looking like it had worked.
 */
/**
 * How many payments.
 *
 * Only the choice is stored — the split is computed from the priced total when
 * the order opens, so a hand-posted "3" cannot name an amount.
 */
export async function chooseInstallments(formData: FormData): Promise<void> {
  const parsed = z.coerce.number().int().min(1).max(3).safeParse(formData.get('installments'));
  if (!parsed.success) return;

  const selection = await readSelection();
  await writeSelection({ ...selection, installments: parsed.data });
}

export async function applyCoupon(_previous: CouponState, formData: FormData): Promise<CouponState> {
  const raw = z.string().max(32).safeParse(formData.get('code'));
  if (!raw.success) return { ok: false, error: 'invalid' };

  const { ok } = await rateLimit(clientKey(await headers(), 'coupon-apply'), {
    limit: 12,
    windowMs: 15 * 60 * 1000,
  });
  if (!ok) return { ok: false, error: 'rateLimited' };

  const selection = await readSelection();

  // Stored, not claimed. `redeem_coupon` still spends it atomically when the
  // order opens; this only decides what the payment screen shows.
  await writeSelection({
    ...selection,
    couponCode: raw.data.trim() !== '' ? raw.data.trim().toUpperCase() : null,
  });

  return { ok: true };
}

export async function resetCheckout(): Promise<void> {
  await writeSelection(EMPTY_SELECTION);
}
