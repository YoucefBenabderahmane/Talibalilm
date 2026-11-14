/**
 * May this order (or instalment) be captured at PayPal?
 *
 * Only while it is `pending`. The sweep cancels a checkout left open for half
 * an hour, and a refused capture marks the order `failed`; both used to be
 * captured anyway when the student came back from PayPal's page, because the
 * only check was "not already paid". `settleOrder` then updated zero rows
 * (its WHERE insists on `pending`), the grant raised "not paid" into a void,
 * the receipt went out, and the student had paid for nothing.
 *
 * Checked before the capture, so the money never moves for an order that
 * cannot be settled. The student is sent back to the module to start again.
 */
export function canCapture(status: string | null | undefined): boolean {
  return status === 'pending';
}
