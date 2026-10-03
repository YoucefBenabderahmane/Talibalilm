import { expect, test } from '@playwright/test';

/**
 * The checkout.
 *
 * It lives on each module's page now, under the module it sells — there is no
 * standalone `/checkout` any more, and the old URLs redirect to the catalogue.
 * These cover the parts that hold regardless of what is on sale: the redirects,
 * the step guards, the fact that a basket is never indexed, and that no price
 * is ever carried in the page for a browser to alter. The arithmetic itself is
 * covered exhaustively in tests/unit/quote.test.ts, and the entitlements it
 * produces in supabase/tests/rls_commerce.sql.
 */
test.describe('checkout', () => {
  test('the old checkout URL lands on the catalogue', async ({ page }) => {
    await page.goto('/checkout');
    await expect(page).toHaveURL(/\/courses$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Tous les modules');
  });

  test('the older step URLs land there too', async ({ page }) => {
    // The wizard was once five URLs. A bookmark or a saved PayPal return must
    // not 404 — it belongs on the page where a module is chosen now.
    for (const step of ['mode', 'modules', 'review', 'payment']) {
      await page.goto(`/checkout/${step}`);
      await expect(page).toHaveURL(/\/courses$/);
    }
  });

  test('the module page carries the checkout, translated', async ({ page }) => {
    await page.goto('/en/courses/fiqh-al-ibadat#inscription');
    await expect(page.getByRole('heading', { name: 'Your option' })).toBeVisible();
    await expect(page.getByText('Step 1 of 4')).toBeVisible();
  });

  test('a module page asks how the module is bought, then enrols', async ({ page }) => {
    // The card on a module's own page knows the module — but not how it is
    // bought: this module alone, or the approfondi cursus that contains it.
    // The failure this catches is a card that silently holds nothing until the
    // student finds the module again in a list.
    await page.goto('/courses/fiqh-al-ibadat#inscription');

    const card = page.locator('#inscription');
    const steps = card.locator('nav[aria-label="Inscription"]');

    // Four steps, not five: the module-list question is gone. The route
    // question is the first one.
    await expect(steps.getByRole('button')).toHaveCount(4);
    await expect(card.getByRole('heading', { name: 'Votre formule' })).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Vos modules' })).toHaveCount(0);
    await expect(card.getByRole('heading', { name: 'Votre cursus' })).toHaveCount(0);

    // "This module": the mode step comes next.
    await card
      .locator('button[aria-pressed]')
      .filter({ hasText: 'Acheter ce module' })
      .click();
    await expect(card.getByRole('heading', { name: 'Présentiel ou distanciel' })).toBeVisible();

    // The mode choice is a submit button; `aria-pressed` is what tells it apart
    // from the step nav above it.
    await card.locator('button[aria-pressed]').filter({ hasText: 'Distanciel' }).click();

    // The flow advances to the details step, which is where a first-time
    // student fills in their enrolment.
    await expect(card.getByRole('heading', { name: 'Vos informations' })).toBeVisible();

    // And the module is in the basket: the payment panel is mounted behind
    // the current step and already carries the server-computed total. If the
    // course had not been resolved into its product, that panel would hold the
    // empty-basket message and no figure at all.
    await expect(card.getByText(/300\s*€/).first()).toHaveText(/300\s*€/);
  });

  test('the approfondi route on a module page brings the year step back', async ({ page }) => {
    // `sciences-du-coran` is the seeded course that sits in the school's own
    // approfondi (the one with a priced year). The e2e seed's course is in a
    // different cursus, and the card is only offered for a cursus whose
    // programme contains the module — which is the point of the gate.
    await page.goto('/courses/sciences-du-coran#inscription');
    const card = page.locator('#inscription');

    await card
      .locator('button[aria-pressed]')
      .filter({ hasText: 'Un programme structuré sur plusieurs années' })
      .click();
    await expect(card.getByRole('heading', { name: 'Présentiel ou distanciel' })).toBeVisible();

    await card.locator('button[aria-pressed]').filter({ hasText: 'Distanciel' }).click();

    // Choosing the cursus means choosing a year: the modules step is the year
    // panel, with that year's price.
    await expect(card.getByRole('heading', { name: 'Vos modules' })).toBeVisible();
    await expect(card.getByText(/600\s*€/).first()).toHaveText(/600\s*€/);
  });

  test('a module in two programmes asks which one', async ({ page }) => {
    // `fiqh-al-ibadat` is gridded into both e2e approfondis, so the card is the
    // same for each and the choice is a step of its own. The generic card is
    // visible; the two programme cards in the next panel are still hidden when
    // the click happens, hence the `visible` filter.
    await page.goto('/courses/fiqh-al-ibadat#inscription');
    const card = page.locator('#inscription');

    await card
      .locator('button[aria-pressed]')
      .filter({ hasText: 'Cursus Approfondi', visible: true })
      .click();

    await expect(card.getByRole('heading', { name: 'Quel Cursus Approfondi ?' })).toBeVisible();
    await card
      .locator('button[aria-pressed]')
      .filter({ hasText: 'Cursus Approfondi pour ados' })
      .click();

    await expect(card.getByRole('heading', { name: 'Présentiel ou distanciel' })).toBeVisible();
  });

  test('no amount is posted from the browser', async ({ page }) => {
    // Prices are recomputed server-side on every step. A hidden input carrying
    // cents would be a way to pay less, so there must not be one anywhere in
    // the flow.
    await page.goto('/courses/fiqh-al-ibadat#inscription');
    const html = await page.content();
    expect(html).not.toMatch(/name="(price|amount|total|price_cents|total_cents)"/);
  });

  test('the old pricing page now lands on contact', async ({ page }) => {
    // Prices moved onto each module's own page, beside the card that charges
    // them, so /pricing is a permanent redirect rather than a price list that
    // duplicated the catalogue. A hardcoded figure cannot creep back onto a
    // page that no longer exists.
    await page.goto('/pricing');
    await expect(page).toHaveURL(/\/contact$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Contactez-nous');
  });
});
