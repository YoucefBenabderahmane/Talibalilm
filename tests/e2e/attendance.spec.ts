import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Attendance, as the two people it concerns see it.
 *
 * A student of a group that held a class they did not open must read "Absent"
 * on their own page; a teacher must be able to change that, and the student
 * must then read what the teacher wrote. Two signed-in browsers, because the
 * point is that one person's click changes the other person's page — and that
 * it goes through the policies, not around them.
 *
 * It needs the CI stack: a live Supabase and the service role to stage the
 * class. The rule itself is proven without a browser in
 * `tests/unit/attendance.test.ts`, and who may write a correction in
 * `supabase/tests/rls_attendance.sql`.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

test.describe('attendance at a live class', () => {
  test.skip(
    !SUPABASE_URL || !SERVICE_ROLE || !process.env.CI,
    'needs the CI stack: a live Supabase plus the service role',
  );

  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const student = { email: `e2e-eleve-${tag}@test.fr`, password: 'E2eEleve!2345', id: '' };
  const teacher = { email: `e2e-prof-${tag}@test.fr`, password: 'E2eProf!2345', id: '' };
  const studentName = `Élève ${tag}`;
  const sessionTitle = `Séance E2E ${tag}`;
  const classId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();

  const serviceHeaders = {
    apikey: SERVICE_ROLE ?? '',
    Authorization: `Bearer ${SERVICE_ROLE ?? ''}`,
  };
  const write = { ...serviceHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' };

  test.beforeAll(async ({ request }) => {
    for (const [who, name] of [
      [student, studentName],
      [teacher, `Prof ${tag}`],
    ] as const) {
      const created = await request.post(`${SUPABASE_URL}/auth/v1/admin/users`, {
        headers: { ...serviceHeaders, 'Content-Type': 'application/json' },
        data: {
          email: who.email,
          password: who.password,
          email_confirm: true,
          user_metadata: { full_name: name, locale: 'fr' },
        },
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      who.id = ((await created.json()) as { id: string }).id;
    }

    const promoted = await request.patch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${teacher.id}`, {
      headers: write,
      data: { role: 'instructor' },
    });
    expect(promoted.ok(), await promoted.text()).toBeTruthy();

    const courses = await request.get(
      `${SUPABASE_URL}/rest/v1/courses?select=id&status=eq.published&limit=1`,
      { headers: serviceHeaders },
    );
    expect(courses.ok(), await courses.text()).toBeTruthy();
    const [course] = (await courses.json()) as { id: string }[];
    expect(course?.id, 'the seed must contain a published module').toBeTruthy();
    if (!course) return;

    const granted = await request.post(`${SUPABASE_URL}/rest/v1/entitlements`, {
      headers: write,
      data: {
        user_id: student.id,
        scope: 'course',
        course_id: course.id,
        delivery: 'online',
        expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      },
    });
    expect(granted.ok(), await granted.text()).toBeTruthy();

    const klass = await request.post(`${SUPABASE_URL}/rest/v1/classes`, {
      headers: write,
      data: { id: classId, course_id: course.id, name: `Classe présence ${tag}` },
    });
    expect(klass.ok(), await klass.text()).toBeTruthy();

    // In the group for ten days: the class below was theirs to attend.
    const member = await request.post(`${SUPABASE_URL}/rest/v1/class_members`, {
      headers: write,
      data: {
        class_id: classId,
        course_id: course.id,
        user_id: student.id,
        joined_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      },
    });
    expect(member.ok(), await member.text()).toBeTruthy();

    // A class that was held two days ago. Nobody opened the room.
    const started = Date.now() - 2 * 86_400_000;
    const session = await request.post(`${SUPABASE_URL}/rest/v1/live_sessions`, {
      headers: write,
      data: {
        id: sessionId,
        course_id: course.id,
        class_id: classId,
        title: sessionTitle,
        status: 'ended',
        scheduled_at: new Date(started).toISOString(),
        started_at: new Date(started).toISOString(),
        ended_at: new Date(started + 90 * 60_000).toISOString(),
      },
    });
    expect(session.ok(), await session.text()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`${SUPABASE_URL}/rest/v1/live_sessions?id=eq.${sessionId}`, {
      headers: serviceHeaders,
    });
    await request.delete(`${SUPABASE_URL}/rest/v1/classes?id=eq.${classId}`, {
      headers: serviceHeaders,
    });
    for (const who of [student, teacher]) {
      if (!who.id) continue;
      await request.delete(`${SUPABASE_URL}/auth/v1/admin/users/${who.id}`, {
        headers: serviceHeaders,
      });
    }
  });

  async function signIn(browser: Browser, who: { email: string; password: string }): Promise<Page> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(who.email);
    await page.locator('input[name="password"]').fill(who.password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/dashboard/);
    return page;
  }

  test('an absence is shown to the student, and the teacher can correct it', async ({
    browser,
  }) => {
    const asStudent = await signIn(browser, student);
    const asTeacher = await signIn(browser, teacher);

    // The student did not open the room: absent, and counted.
    const past = asStudent.getByTestId('past-classes');
    const mine = past.getByRole('listitem').filter({ hasText: sessionTitle });
    await expect(mine).toHaveAttribute('data-status', 'absent');
    await expect(mine.getByText('Absent', { exact: true })).toBeVisible();
    await expect(past.getByTestId('attendance-summary')).toHaveText('Présence : 0 sur 1 séance');

    // The teacher's roll lists the student the log cannot: the one who never came.
    await asTeacher.goto(`/admin/live/${sessionId}`);
    const roll = asTeacher.getByTestId('attendance-roll');
    const row = roll.locator(`tr[data-user="${student.id}"]`);
    await expect(row).toHaveAttribute('data-status', 'absent');
    await expect(row.getByText(studentName)).toBeVisible();
    await expect(roll.getByTestId('roll-totals')).toContainText('1 absent');

    // Excused by the teacher, under their own name, through the policy.
    await row.getByRole('button', { name: 'Excusé' }).click();
    await expect(row).toHaveAttribute('data-status', 'excused');
    await expect(row.getByText('corrigé')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Excusé' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // …and that is what the student now reads.
    await asStudent.reload();
    await expect(mine).toHaveAttribute('data-status', 'excused');
    await expect(past.getByTestId('attendance-summary')).toHaveText(
      'Présence : 0 sur 1 séance · 1 absence excusée',
    );

    // An on-site student: the teacher says they were there.
    await row.getByRole('button', { name: 'Présent' }).click();
    await expect(row).toHaveAttribute('data-status', 'present');
    await asStudent.reload();
    await expect(mine).toHaveAttribute('data-status', 'present');
    await expect(past.getByTestId('attendance-summary')).toHaveText('Présence : 1 sur 1 séance');

    // "Automatique" removes the correction: back to what the room recorded.
    await row.getByRole('button', { name: 'Automatique' }).click();
    await expect(row).toHaveAttribute('data-status', 'absent');
    await expect(row.getByText('corrigé')).toHaveCount(0);
    await asStudent.reload();
    await expect(mine).toHaveAttribute('data-status', 'absent');

    await asStudent.context().close();
    await asTeacher.context().close();
  });
});
