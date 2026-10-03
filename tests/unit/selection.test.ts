import { describe, expect, it } from 'vitest';
import { afterCursusChoice, EMPTY_SELECTION, type Selection } from '@/lib/commerce/selection';

const MODULE = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const CURSUS_A = '33333333-3333-4333-8333-333333333333';
const CURSUS_B = '44444444-4444-4444-8444-444444444444';

const moduleBasket: Selection = {
  ...EMPTY_SELECTION,
  kind: 'module',
  courseId: MODULE,
  delivery: 'online',
  productIds: [PRODUCT],
};

const cursusBasket: Selection = {
  ...EMPTY_SELECTION,
  kind: 'approfondi',
  cursusId: CURSUS_A,
  delivery: 'online',
  yearIndex: 2,
  productIds: [PRODUCT],
};

describe('afterCursusChoice', () => {
  it('clears a module basket when the approfondi route is chosen, even though both name no cursus', () => {
    // The card is the same for every Approfondi, so the pending choice carries
    // `cursusId = null` — the same value a module carries. Comparing the cursus
    // alone would keep the module's delivery and product.
    const next = afterCursusChoice(moduleBasket, {
      kind: 'approfondi',
      cursusId: null,
      courseId: null,
    });
    expect(next.kind).toBe('approfondi');
    expect(next.cursusId).toBeNull();
    expect(next.courseId).toBeNull();
    expect(next.delivery).toBeNull();
    expect(next.productIds).toEqual([]);
  });

  it('starts over when the cursus changes', () => {
    const next = afterCursusChoice(cursusBasket, {
      kind: 'approfondi',
      cursusId: CURSUS_B,
      courseId: null,
    });
    expect(next.cursusId).toBe(CURSUS_B);
    expect(next.delivery).toBeNull();
    expect(next.productIds).toEqual([]);
    expect(next.yearIndex).toBe(1);
  });

  it('keeps the downstream answers when the same route is chosen again', () => {
    const next = afterCursusChoice(cursusBasket, {
      kind: 'approfondi',
      cursusId: CURSUS_A,
      courseId: null,
    });
    expect(next.delivery).toBe('online');
    expect(next.productIds).toEqual([PRODUCT]);
    expect(next.yearIndex).toBe(2);
  });

  it('keeps a module basket when its own card is pressed again', () => {
    const next = afterCursusChoice(moduleBasket, {
      kind: 'module',
      cursusId: null,
      courseId: MODULE,
    });
    expect(next.delivery).toBe('online');
    expect(next.productIds).toEqual([PRODUCT]);
    expect(next.courseId).toBe(MODULE);
  });
});
