import { expect, test } from '@playwright/test';

/**
 * The admin course builder actually renders.
 *
 * This exists because one class of bug is invisible to every other check:
 * a client function called during a server render passes `next build`, passes
 * `tsc`, passes lint and passes the unit suite, and only throws when the route
 * is rendered. It reached production twice — the second time it locked the
 * school out of every module it ticked a cursus box on.
 *
 * So this test signs in as a real admin and opens a real course. It creates
 * the admin through the service-role API, because the role column is guarded
 * so only that role can write it, and removes the account afterwards.
 *
 * It runs in CI only: there the Supabase stack is the throwaway one the e2e
 * job just started. Run locally against a real project, this would create an
 * admin account on it, which is not a side effect a test may have.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

test.describe('the admin course builder', () => {
  test.skip(
    !SUPABASE_URL || !SERVICE_ROLE || !process.env.CI,
    'needs the CI stack: a live Supabase plus the service role',
  );

  const email = `e2e-admin-${Date.now()}@test.fr`;
  const password = 'E2eAdmin!2345';
  let userId = '';

  const serviceHeaders = {
    apikey: SERVICE_ROLE ?? '',
    Authorization: `Bearer ${SERVICE_ROLE ?? ''}`,
  };

  test.beforeAll(async ({ request }) => {
    const created = await request.post(`${SUPABASE_URL}/auth/v1/admin/users`, {
      headers: { ...serviceHeaders, 'Content-Type': 'application/json' },
      data: {
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: 'E2E Admin', locale: 'fr' },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    userId = ((await created.json()) as { id: string }).id;

    // The one column a signed-in user may never write, written by the only
    // role allowed to: the same door the office uses in the dashboard.
    const promoted = await request.patch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
      headers: { ...serviceHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      data: { role: 'admin' },
    });
    expect(promoted.ok(), await promoted.text()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (!userId) return;
    // Cascades to the profile, so no stray admin row is left behind.
    await request.delete(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: serviceHeaders,
    });
  });

  test('a course opens without the error screen', async ({ page, request }) => {
    const list = await request.get(`${SUPABASE_URL}/rest/v1/courses?select=id,title&limit=1`, {
      headers: serviceHeaders,
    });
    expect(list.ok(), await list.text()).toBeTruthy();
    const [course] = (await list.json()) as { id: string; title: string }[];
    expect(course?.id, 'the seed must contain at least one course').toBeTruthy();

    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/dashboard/);

    await page.goto(`/admin/courses/${course.id}`);

    // The builder's own heading, read from the database. A page that failed to
    // render never shows it.
    await expect(page.getByRole('heading', { level: 1, name: course.title })).toBeVisible();
    await expect(page.getByText('Cet écran d’administration n’a pas pu s’afficher')).toHaveCount(0);

    // The module's groups live on their own step: the office creates them
    // here, the students join one from the module's public page.
    await page
      .getByRole('navigation', { name: 'Étapes du module' })
      .getByRole('button', { name: /Classes/ })
      .click();
    await expect(page.getByRole('button', { name: 'Créer la classe' })).toBeVisible();
  });

  test('the cursus screen renders, with its year pickers', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/dashboard/);

    await page.goto('/admin/cursus');

    // The screen the module page no longer owns: each cursus, its years, its
    // prices and the programme that decides which modules it opens.
    await expect(page.getByRole('heading', { level: 1, name: 'Cursus' })).toBeVisible();
    await expect(page.getByText('Cet écran d’administration n’a pas pu s’afficher')).toHaveCount(0);

    // The programme lives under an approfondi tab: one dropdown of modules per
    // year. Asserted, not toggled: every test shares one database, and saving
    // here would change what the checkout spec sees.
    await page.getByRole('tab', { name: 'Cursus Approfondi' }).first().click();
    await expect(page.getByRole('button', { name: /Choisir les modules/ }).first()).toBeVisible();
    await expect(page.locator('input[name="course_ids"]').first()).toBeAttached();

    // One price per year, both modes in one figure.
    await expect(page.locator('input[name="price"]:visible').first()).toBeVisible();

    // Creating one starts from a module and prices it: the create tab carries
    // the module dropdown and the tariff. Nothing is submitted.
    await page.getByRole('tab', { name: '+ Nouveau cursus' }).click();
    await expect(page.locator('select[name="course_id"]:visible')).toBeVisible();
    await expect(page.locator('input[name="price"]:visible')).toBeVisible();
  });
});
