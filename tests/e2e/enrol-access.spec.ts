import { expect, test } from '@playwright/test';

/**
 * The module page knows who already holds the module.
 *
 * A student who bought it — or whose paid cursus covers it — must not be shown
 * the checkout again, and must not be handed a card asking them to open what
 * they hold: `has_course_access` is asked on the server, the enrolment section
 * disappears, and every lesson in the programme becomes a link to its lesson.
 * A signed-out visitor still sees the enrolment card, because that is the only
 * way to buy.
 *
 * CI only: it creates a student and an entitlement through the service role,
 * which must never happen against a real project.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

test.describe('the module page and who holds it', () => {
  test.skip(
    !SUPABASE_URL || !SERVICE_ROLE || !process.env.CI,
    'needs the CI stack: a live Supabase plus the service role',
  );

  const email = `e2e-owner-${Date.now()}@test.fr`;
  const password = 'E2eOwner!2345';
  // Unique per worker: desktop and mobile run this describe at the same time
  // against one database, and a class name is unique per module.
  const groupName = `Classe E2E ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let userId = '';
  let slug = '';

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
        user_metadata: { full_name: 'E2E Owner', locale: 'fr' },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    userId = ((await created.json()) as { id: string }).id;

    const courses = await request.get(
      `${SUPABASE_URL}/rest/v1/courses?select=id,slug,modules(count)&status=eq.published`,
      { headers: serviceHeaders },
    );
    expect(courses.ok(), await courses.text()).toBeTruthy();
    // A course WITH lessons: the access panel opens the first lesson, and a
    // lesson-less course would legitimately fall back to the dashboard.
    const [course] = (
      (await courses.json()) as { id: string; slug: string; modules: { count: number }[] }[]
    ).filter((c) => (c.modules?.[0]?.count ?? 0) > 0);
    expect(course?.id, 'the seed must contain a published course with lessons').toBeTruthy();
    slug = course.slug;

    // A paid year, in effect: the same row the grant path writes.
    const granted = await request.post(`${SUPABASE_URL}/rest/v1/entitlements`, {
      headers: { ...serviceHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      data: {
        user_id: userId,
        scope: 'course',
        course_id: course.id,
        delivery: 'online',
        expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      },
    });
    expect(granted.ok(), await granted.text()).toBeTruthy();

    // A group to choose from: the module page offers the classes the office
    // built, and the student joins one themselves.
    const klass = await request.post(`${SUPABASE_URL}/rest/v1/classes`, {
      headers: { ...serviceHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      data: { course_id: course.id, name: groupName, schedule: 'Samedi 9h – 12h' },
    });
    expect(klass.ok(), await klass.text()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (!userId) return;
    await request.delete(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: serviceHeaders,
    });
  });

  test('a signed-out visitor is offered the enrolment', async ({ page }) => {
    await page.goto(`/courses/${slug}`);
    await expect(page.getByText('Inscriptions & paiements')).toBeVisible();
    await expect(page.getByText('Ouvrir le module')).toHaveCount(0);
  });

  test('a student who holds it gets the lessons themselves', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/dashboard/);

    await page.goto(`/courses/${slug}`);

    // No card, no button, no enrolment: the programme above IS the way in.
    await expect(page.getByText('Inscriptions & paiements')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Votre accès' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Ouvrir le module' })).toHaveCount(0);

    // Every lesson is a link to its own page, not a locked row.
    const lesson = page.getByRole('link', { name: 'Les eaux et les impuretés' });
    await expect(lesson).toBeVisible();
    await expect(lesson).toHaveAttribute(
      'href',
      new RegExp(`/dashboard/courses/${slug}/lessons/`),
    );

    // The group is the student's to choose, and the choice sticks.
    await expect(page.getByRole('heading', { name: 'Votre classe' })).toBeVisible();
    const group = page.getByRole('button', { name: new RegExp(groupName) });
    await group.click();
    await expect(group).toHaveAttribute('aria-pressed', 'true');
  });
});

/**
 * The cursus route, same page. A student whose paid cursus covers the module
 * must be offered the way in too — this is the entitlement the checkout writes
 * when the approfondi is bought (`scope = 'cursus'` + year + mode), and
 * `has_course_access` answers it from the programme grid.
 */
test.describe('the module page and a cursus that covers it', () => {
  test.skip(
    !SUPABASE_URL || !SERVICE_ROLE || !process.env.CI,
    'needs the CI stack: a live Supabase plus the service role',
  );

  const email = `e2e-cursus-${Date.now()}@test.fr`;
  const password = 'E2eCursus!2345';
  let userId = '';
  let slug = '';

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
        user_metadata: { full_name: 'E2E Cursus', locale: 'fr' },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    userId = ((await created.json()) as { id: string }).id;

    // A grid row: which course sits in which year of which cursus, in which
    // mode. The entitlement below mirrors it exactly. Pinned to the e2e
    // approfondi so the course has a syllabus the test can assert on.
    const grid = await request.get(
      `${SUPABASE_URL}/rest/v1/cursus_courses?select=cursus_id,course_id,year_index,delivery,courses(slug)&cursus_id=eq.e2e30000-0000-4000-8000-000000000002&order=position&limit=1`,
      { headers: serviceHeaders },
    );
    expect(grid.ok(), await grid.text()).toBeTruthy();
    const [row] = (await grid.json()) as {
      cursus_id: string;
      course_id: string;
      year_index: number;
      delivery: 'presentiel' | 'online';
      courses: { slug: string };
    }[];
    expect(row?.course_id, 'the seed must grid a course into a cursus').toBeTruthy();
    slug = row.courses.slug;

    const granted = await request.post(`${SUPABASE_URL}/rest/v1/entitlements`, {
      headers: { ...serviceHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      data: {
        user_id: userId,
        scope: 'cursus',
        cursus_id: row.cursus_id,
        year_index: row.year_index,
        delivery: row.delivery,
        expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      },
    });
    expect(granted.ok(), await granted.text()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (!userId) return;
    await request.delete(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: serviceHeaders,
    });
  });

  test('a student holding the cursus gets the lessons of its module', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/dashboard/);

    await page.goto(`/courses/${slug}`);

    await expect(page.getByText('Inscriptions & paiements')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Ouvrir le module' })).toHaveCount(0);

    const lesson = page.getByRole('link', { name: 'Les eaux et les impuretés' });
    await expect(lesson).toBeVisible();
    await expect(lesson).toHaveAttribute(
      'href',
      new RegExp(`/dashboard/courses/${slug}/lessons/`),
    );
  });
});
