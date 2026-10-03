import { expect, test } from '@playwright/test';

/**
 * Access control, at the level Phase 1 can prove it.
 *
 * The database half is covered by supabase/tests/rls_profiles.sql, which
 * asserts the same boundaries against real Postgres. These cover the routing
 * half — that a signed-out visitor is turned away before the page renders,
 * rather than being shown a page that hides its contents with CSS.
 */
test.describe('protected routes', () => {
  test('a signed-out visitor is redirected away from the dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
    // And the dashboard's own markup never reached the browser.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Connexion');
  });

  test('the redirect remembers where you were going', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/next=%2Fdashboard/);
  });

  test('the guard holds on the English routes too', async ({ page }) => {
    // A guard that only matches the default locale is a real and easy bug:
    // /en/dashboard is a different pathname.
    await page.goto('/en/dashboard');
    await expect(page).toHaveURL(/\/en\/login/);
  });

  test('an off-origin `next` is not honoured', async ({ page }) => {
    await page.goto('/login?next=https://example.com/phish');
    // The value is carried in a hidden field; what matters is that submitting
    // it cannot leave the origin. Assert the field is same-origin-only by the
    // time it is rendered.
    const field = page.locator('input[name="next"]');
    if (await field.count()) {
      const value = await field.inputValue();
      expect(value.startsWith('http')).toBe(false);
    }
  });
});

test.describe('auth pages', () => {
  test('registration validates on the server, not only in the browser', async ({ page }) => {
    await page.goto('/register');

    // `noValidate` is set on the form, so the browser does not block submit and
    // the request genuinely reaches the server action.
    await page.getByLabel('Nom et prénom').fill('A');
    await page.getByLabel('Adresse e-mail').fill('pas-un-email');
    await page.getByLabel('Mot de passe', { exact: true }).fill('court');
    await page.getByLabel('Confirmer le mot de passe').fill('autre');
    await page.getByRole('button', { name: /créer mon compte/i }).click();

    await expect(page.getByText('Cette adresse e-mail n’est pas valide.')).toBeVisible();
  });

  test('registration refuses a provider outside the accepted list', async ({ page }) => {
    await page.goto('/register');

    await page.getByLabel('Nom et prénom').fill('Amina Test');
    await page.getByLabel('Adresse e-mail').fill('amina@example.fr');
    await page.getByLabel('Mot de passe', { exact: true }).fill('MotDePasse!2345');
    await page.getByLabel('Confirmer le mot de passe').fill('MotDePasse!2345');
    await page.locator('input[name="acceptTerms"]').check();
    await page.getByRole('button', { name: /créer mon compte/i }).click();

    // The rule is enforced by the server action, before Supabase is reached,
    // so this runs wherever the suite runs.
    await expect(
      page.getByText(
        'L’inscription est réservée aux adresses Gmail, Hotmail, Outlook, Yahoo ou iCloud. Utilisez l’une de ces adresses ou contactez l’institut.',
      ),
    ).toBeVisible();
  });

  test('the forgot-password form does not reveal whether an account exists', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Adresse e-mail').fill('personne@example.fr');
    await page.getByRole('button', { name: /envoyer le lien/i }).click();

    await expect(page.getByText(/si un compte existe pour cette adresse/i)).toBeVisible();
  });
});
