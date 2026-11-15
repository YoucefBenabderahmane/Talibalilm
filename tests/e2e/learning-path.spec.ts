import { expect, test } from '@playwright/test';

/**
 * The guided path through a module, as a student walks it.
 *
 * Three things that were broken and that nothing asserted: a module bought but
 * never opened was missing from "Mes formations"; "Reprendre" always opened
 * lesson 1; and finishing a lesson did not lead anywhere. This walks the whole
 * route in one browser session, because each step depends on the progress the
 * step before it wrote.
 *
 * It needs the CI stack — a live Supabase and the service role to stage a
 * student who holds a module — so it skips anywhere else. The rules themselves
 * are proven without a browser too: `tests/unit/learn-path.test.ts` for the
 * order and the percentages, `supabase/tests/rls_my_courses.sql` for which
 * modules the dashboard may list.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

test.describe('the learning path', () => {
  test.skip(
    !SUPABASE_URL || !SERVICE_ROLE || !process.env.CI,
    'needs the CI stack: a live Supabase plus the service role',
  );

  // Its own client address: the login form allows ten attempts per address in
  // fifteen minutes, and the project's shared address is used by every spec
  // that signs in. A retry elsewhere must not be what refuses this one.
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': '10.30.0.1' } });

  const email = `e2e-path-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.fr`;
  const password = 'E2ePath!2345';
  const groupName = `Classe parcours ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const classId = crypto.randomUUID();
  let userId = '';
  let slug = '';
  let title = '';
  let ordered: { id: string; title: string }[] = [];

  const serviceHeaders = {
    apikey: SERVICE_ROLE ?? '',
    Authorization: `Bearer ${SERVICE_ROLE ?? ''}`,
  };
  const write = { ...serviceHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' };

  test.beforeAll(async ({ request }) => {
    const created = await request.post(`${SUPABASE_URL}/auth/v1/admin/users`, {
      headers: { ...serviceHeaders, 'Content-Type': 'application/json' },
      data: {
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: 'E2E Parcours', locale: 'fr' },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    userId = ((await created.json()) as { id: string }).id;

    // A published module with at least two lessons, in the order the site
    // walks them: by module, then by lesson.
    const courses = await request.get(
      `${SUPABASE_URL}/rest/v1/courses?select=id,slug,title,modules(position,lessons(id,title,position))&status=eq.published`,
      { headers: serviceHeaders },
    );
    expect(courses.ok(), await courses.text()).toBeTruthy();
    type Row = {
      id: string;
      slug: string;
      title: string;
      modules: { position: number; lessons: { id: string; title: string; position: number }[] }[];
    };
    const flatten = (course: Row) =>
      course.modules
        .slice()
        .sort((a, b) => a.position - b.position)
        .flatMap((m) => m.lessons.slice().sort((a, b) => a.position - b.position));
    const course = ((await courses.json()) as Row[]).find((c) => flatten(c).length >= 2);
    expect(course?.id, 'the seed must contain a published module with two lessons').toBeTruthy();
    if (!course) return;
    slug = course.slug;
    title = course.title;
    ordered = flatten(course);

    // Bought, and never opened: no enrolment row exists for this student.
    const granted = await request.post(`${SUPABASE_URL}/rest/v1/entitlements`, {
      headers: write,
      data: {
        user_id: userId,
        scope: 'course',
        course_id: course.id,
        delivery: 'online',
        expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      },
    });
    expect(granted.ok(), await granted.text()).toBeTruthy();

    // Their group, with the first two lessons published for it.
    const klass = await request.post(`${SUPABASE_URL}/rest/v1/classes`, {
      headers: write,
      data: { id: classId, course_id: course.id, name: groupName, schedule: 'Dimanche 10h' },
    });
    expect(klass.ok(), await klass.text()).toBeTruthy();

    const member = await request.post(`${SUPABASE_URL}/rest/v1/class_members`, {
      headers: write,
      data: { class_id: classId, course_id: course.id, user_id: userId },
    });
    expect(member.ok(), await member.text()).toBeTruthy();

    const content = await request.post(`${SUPABASE_URL}/rest/v1/class_lesson_content`, {
      headers: write,
      data: ordered.slice(0, 2).map((lesson, i) => ({
        class_id: classId,
        lesson_id: lesson.id,
        content: `Texte du parcours ${i + 1}`,
      })),
    });
    expect(content.ok(), await content.text()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (userId) {
      await request.delete(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        headers: serviceHeaders,
      });
    }
    await request.delete(`${SUPABASE_URL}/rest/v1/classes?id=eq.${classId}`, {
      headers: serviceHeaders,
    });
  });

  test('a bought module is listed, started, continued and resumed', async ({ page }) => {
    const total = ordered.length;
    const [first, second] = ordered;
    if (!first || !second) throw new Error('the seed lost its lessons');
    const lessonUrl = (id: string) => new RegExp(`/dashboard/courses/${slug}/lessons/${id}$`);

    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/dashboard/);

    // Never opened, and already on the dashboard: holding it is enough.
    const card = page.getByTestId('my-course').filter({ hasText: title });
    await expect(card).toBeVisible();
    await expect(card.getByText(`0 sur ${total} leçons terminées`)).toBeVisible();

    // The first step says "start", and starts at the beginning.
    await card.getByRole('link', { name: 'Commencer' }).click();
    await expect(page).toHaveURL(lessonUrl(first.id));
    await expect(page.getByText(`Leçon 1 sur ${total}`)).toBeVisible();
    await expect(page.getByText('Texte du parcours 1')).toBeVisible();

    // One act: finish this lesson, arrive on the next.
    await page.getByTestId('finish-and-continue').click();
    await expect(page).toHaveURL(lessonUrl(second.id));
    await expect(page.getByText(`Leçon 2 sur ${total}`)).toBeVisible();
    await expect(page.getByText('Texte du parcours 2')).toBeVisible();

    // The dashboard now resumes where the student is, not at lesson 1.
    await page.goto('/dashboard');
    const resumed = page.getByTestId('my-course').filter({ hasText: title });
    await expect(resumed.getByText(`1 sur ${total} leçons terminées`)).toBeVisible();
    await expect(resumed.getByRole('link', { name: 'Reprendre' })).toHaveAttribute(
      'href',
      lessonUrl(second.id),
    );

    // And so does the module's own home.
    await resumed.getByRole('link', { name: title }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/courses/${slug}$`));
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByTestId('resume-course')).toHaveAttribute('href', lessonUrl(second.id));
  });
});
