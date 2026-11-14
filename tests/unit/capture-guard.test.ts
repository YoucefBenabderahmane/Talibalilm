import { describe, expect, it } from 'vitest';
import { canCapture } from '@/lib/commerce/capture-guard';

describe('canCapture', () => {
  it('lets a pending order or instalment through', () => {
    expect(canCapture('pending')).toBe(true);
  });

  it('refuses everything the settlement could not complete', () => {
    // The sweep's work, a refused capture, a refund, a replay, and the unknown.
    for (const status of ['cancelled', 'failed', 'refunded', 'paid', '', null, undefined]) {
      expect(canCapture(status)).toBe(false);
    }
  });
});
