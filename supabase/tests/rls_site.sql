-- ---------------------------------------------------------------------------
-- Policy tests for the site content tables.
--
-- Three separate claims, and each one is a different way to get it wrong:
--
--   * A DRAFT event or review is not public. The homepage filters on status in
--     its query, and a filter in a query is a convenience, not a gate — take
--     the filter out and the database must still refuse.
--   * `contact_messages` is insert-only for a stranger. Anyone may write to the
--     school; nobody may read back what anyone else wrote, or the table becomes
--     a list of who has contacted the institute and what about.
--   * `site_settings` is readable by everyone and writable by nobody but staff.
--     It is a banner and a footer, so the read is deliberately open — the thing
--     worth asserting is that an ordinary student cannot edit the banner on
--     every page of the site.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

create or replace function public.assert(ok boolean, what text)
returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', what; end if;
  raise notice '  ok  %', what;
end $$;
-- Callable from the roles the tests switch to: since the function-grants
-- migration a new function starts closed, as it does on Supabase once that
-- migration has run.
grant execute on function public.assert(boolean, text) to anon, authenticated, service_role;

-- --- fixtures -------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000001', 'student@test.fr', '{"full_name":"Étudiante"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000002', 'admin@test.fr',   '{"full_name":"Direction"}'::jsonb);

update public.profiles set role = 'admin' where id = 'a0000000-0000-0000-0000-000000000002';

insert into public.events (id, title, status, phase) values
  ('b0000000-0000-0000-0000-000000000001', 'Portes ouvertes', 'published', 'upcoming'),
  ('b0000000-0000-0000-0000-000000000002', 'Brouillon',       'draft',     'finished');

insert into public.reviews (id, author_name, quote, status) values
  ('c0000000-0000-0000-0000-000000000001', 'Fatima', 'Un enseignement clair et exigeant.', 'published'),
  ('c0000000-0000-0000-0000-000000000002', 'Anonyme', 'Pas encore relu par la direction.', 'draft');

insert into public.contact_messages (id, name, email, body) values
  ('d0000000-0000-0000-0000-000000000001', 'Visiteur', 'visiteur@test.fr',
   'Bonjour, quels sont les horaires ?');

\echo '=== site content policy tests ==='

do $$
begin
  raise notice 'a stranger reads the published content and nothing else';
  set local role anon;

  perform public.assert(
    (select count(*) from public.events) = 1,
    'anon sees the published event');
  perform public.assert(
    not exists (select 1 from public.events where status = 'draft'),
    'a DRAFT event is invisible — the status filter in the page is not the gate');
  perform public.assert(
    (select phase from public.events
      where id = 'b0000000-0000-0000-0000-000000000001') = 'upcoming',
    'the event phase travels with the published row, à venir to terminé');

  perform public.assert(
    (select count(*) from public.reviews) = 1,
    'anon sees the published review');
  perform public.assert(
    not exists (select 1 from public.reviews where status = 'draft'),
    'a review the school has not approved yet is invisible');

  perform public.assert(
    (select count(*) from public.site_settings) = 1,
    'the banner and the footer links are public, as they must be');

  reset role;
end $$;

do $$
declare
  refused boolean;
begin
  raise notice 'a stranger may write to the school, and may not read the postbag';

  -- The read is refused by the GRANT, before any policy is consulted — there
  -- is no `select` on this table for `anon` at all. That is deliberately
  -- stronger than a policy returning no rows: a policy can be loosened by
  -- accident, and this cannot be reached to loosen.
  refused := false;
  begin
    set local role anon;
    perform count(*) from public.contact_messages;
  exception when insufficient_privilege then
    refused := true;
  end;
  reset role;
  perform public.assert(refused,
    'anon is refused the contact messages outright — no select grant, not merely no rows');

  set local role anon;
  insert into public.contact_messages (name, email, body)
  values ('Curieux', 'curieux@test.fr', 'Je voudrais m''inscrire au cursus.');
  reset role;
  perform public.assert(
    exists (select 1 from public.contact_messages where email = 'curieux@test.fr'),
    'anon CAN leave a message, and it really lands');

  -- Having written one, they still cannot read it back. This is what stops the
  -- form becoming a way to enumerate the school's enquiries.
  refused := false;
  begin
    set local role anon;
    perform count(*) from public.contact_messages;
  exception when insufficient_privilege then
    refused := true;
  end;
  reset role;
  perform public.assert(refused, 'and still cannot read it back afterwards');

  refused := false;
  begin
    set local role anon;
    update public.contact_messages set handled_at = now();
  exception when insufficient_privilege then
    refused := true;
  end;
  reset role;
  perform public.assert(refused, 'anon cannot mark anything as handled');
end $$;

do $$
declare
  changed integer;
begin
  raise notice 'an ordinary student is not staff';
  call auth.login_as('a0000000-0000-0000-0000-000000000001');

  perform public.assert(
    (select count(*) from public.events) = 1,
    'a signed-in student sees published events only');
  perform public.assert(
    (select count(*) from public.contact_messages) = 0,
    'a signed-in student cannot read the contact messages either');

  -- No error: the policy makes the row invisible, so the update matches
  -- nothing. That is the shape to assert — "it threw" would pass for the
  -- wrong reason the day the policy changes to a visible-but-refused one.
  update public.site_settings set announcement_text = 'Piraté';
  get diagnostics changed = row_count;
  perform public.assert(changed = 0, 'a student cannot rewrite the site-wide banner');

  update public.events set title = 'Piraté';
  get diagnostics changed = row_count;
  perform public.assert(changed = 0, 'nor edit an event');

  update public.reviews set quote = 'Piraté';
  get diagnostics changed = row_count;
  perform public.assert(changed = 0, 'nor put words in another student''s mouth');

  reset role;
end $$;

do $$
declare
  changed integer;
begin
  raise notice 'staff see the drafts and own the writes';
  call auth.login_as('a0000000-0000-0000-0000-000000000002');

  perform public.assert(
    (select count(*) from public.events) = 2,
    'staff see the draft event as well as the published one');
  perform public.assert(
    (select count(*) from public.reviews) = 2,
    'staff see the unapproved review');
  perform public.assert(
    (select count(*) from public.contact_messages) >= 1,
    'staff read the contact messages');

  update public.site_settings set announcement_text = 'Inscriptions ouvertes';
  get diagnostics changed = row_count;
  perform public.assert(changed = 1, 'staff edit the banner');

  update public.contact_messages set handled_at = now()
  where id = 'd0000000-0000-0000-0000-000000000001';
  get diagnostics changed = row_count;
  perform public.assert(changed = 1, 'staff mark a message as handled');

  reset role;
end $$;

do $$
declare
  refused boolean := false;
begin
  raise notice 'the single-row rule on site_settings is the database''s, not the app''s';
  call auth.login_as('a0000000-0000-0000-0000-000000000002');
  begin
    insert into public.site_settings (id) values (false);
  exception when check_violation or unique_violation then
    refused := true;
  end;
  perform public.assert(refused, 'a second settings row cannot be created');
  reset role;
end $$;



-- ---------------------------------------------------------------------------
-- A new registration is a notification
--
-- There is no gate here any more: `reviewed_at` grants nothing and refuses
-- nothing, it only says whether the office has looked. What is still worth
-- asserting is that the OFFICE is the one who decides it — a student cannot
-- clear their own notification — and that marking twice is not two events, so
-- the audit log cannot be inflated by pressing the button again.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000003', 'nouveau@test.fr', '{"full_name":"Nouvelle"}'::jsonb),
  -- A second unseen registration, so the staff-only assertion at the end has
  -- something real to hide. Asserting "a student sees 0" against a database
  -- where the true answer is also 0 would pass for the wrong reason.
  ('a0000000-0000-0000-0000-000000000004', 'autre@test.fr',   '{"full_name":"Autre"}'::jsonb);

-- `handle_new_user` marks nobody as seen, so every fixture account above
-- arrives exactly as a real registration does. The migration's back-fill
-- cannot be observed from here — it ran before any of these rows existed — so
-- an account the office has already looked at is set up explicitly instead of
-- pretended into existence.
update public.profiles set reviewed_at = now()
where id = 'a0000000-0000-0000-0000-000000000001';

do $$
begin
  raise notice 'registrations — what the badge counts';
  call auth.login_as('a0000000-0000-0000-0000-000000000002');

  perform public.assert(
    (select reviewed_at is null from public.profiles
      where id = 'a0000000-0000-0000-0000-000000000003'),
    'a fresh registration has not been seen yet');
  perform public.assert(
    (select reviewed_at is not null from public.profiles
      where id = 'a0000000-0000-0000-0000-000000000001'),
    'one the office has already looked at carries a date');
  perform public.assert(public.unreviewed_student_count() = 2,
    'the badge counts exactly the registrations nobody has opened');

  reset role;
end $$;

do $$
declare
  refused boolean := false;
begin
  raise notice 'registrations — only an admin clears the notification';
  call auth.login_as('a0000000-0000-0000-0000-000000000003');
  begin
    perform public.admin_mark_reviewed('a0000000-0000-0000-0000-000000000003');
  exception when insufficient_privilege then
    refused := true;
  end;
  reset role;
  perform public.assert(refused, 'a student cannot mark their own registration as seen');

  perform public.assert(
    (select reviewed_at is null from public.profiles
      where id = 'a0000000-0000-0000-0000-000000000003'),
    'and it is still unseen afterwards');
end $$;

do $$
declare
  marked boolean;
  rows_before integer;
  rows_after integer;
begin
  raise notice 'registrations — the office presses Vu, once';
  call auth.login_as('a0000000-0000-0000-0000-000000000002');

  marked := public.admin_mark_reviewed('a0000000-0000-0000-0000-000000000003');
  perform public.assert(marked, 'marking an unseen registration reports a real change');
  perform public.assert(
    (select reviewed_at is not null from public.profiles
      where id = 'a0000000-0000-0000-0000-000000000003'),
    'the date lands');
  perform public.assert(public.unreviewed_student_count() = 1,
    'and the badge drops by exactly one — the other registration still waits');

  select count(*) into rows_before from public.admin_audit
  where action = 'student.reviewed'
    and target_id = 'a0000000-0000-0000-0000-000000000003';
  perform public.assert(rows_before = 1, 'who cleared it is on the record');

  -- Idempotent, and it says so by returning false. This used to be what
  -- stopped a second welcome e-mail; with the e-mail gone it is what stops a
  -- second audit row for the same event.
  marked := public.admin_mark_reviewed('a0000000-0000-0000-0000-000000000003');
  perform public.assert(not marked, 'pressing it again is not an event');

  select count(*) into rows_after from public.admin_audit
  where action = 'student.reviewed'
    and target_id = 'a0000000-0000-0000-0000-000000000003';
  perform public.assert(rows_after = rows_before,
    'and writes no second audit row');

  reset role;
end $$;

do $$
begin
  raise notice 'registrations — the count is staff-only';
  call auth.login_as('a0000000-0000-0000-0000-000000000003');
  -- One registration really is unseen at this point, so a zero here is the
  -- function refusing rather than the table being empty.
  perform public.assert(public.unreviewed_student_count() = 0,
    'a student cannot use the badge to count the school''s registrations');
  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- Push subscriptions
--
-- A subscription is a capability, not merely a record: anyone holding one can
-- make that device buzz. So it is owner-only, and deliberately owner-only even
-- against STAFF — the teacher has no business reading which devices a student
-- has registered, and the send path does not need a policy because it runs as
-- the service role from a background job.
-- ---------------------------------------------------------------------------

insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('a0000000-0000-0000-0000-000000000001', 'https://push.example/aaa', 'k1', 'a1'),
  ('a0000000-0000-0000-0000-000000000002', 'https://push.example/bbb', 'k2', 'a2');

do $$
declare
  refused boolean := false;
begin
  raise notice 'push — a stranger has no business here at all';
  begin
    set local role anon;
    perform count(*) from public.push_subscriptions;
  exception when insufficient_privilege then
    refused := true;
  end;
  reset role;
  perform public.assert(refused,
    'anon is refused outright — no select grant, so the policy is never even reached');
end $$;

do $$
declare
  changed integer;
begin
  raise notice 'push — a device belongs to one person';
  call auth.login_as('a0000000-0000-0000-0000-000000000001');

  perform public.assert(
    (select count(*) from public.push_subscriptions) = 1,
    'a student sees their own subscription and no other');
  perform public.assert(
    not exists (select 1 from public.push_subscriptions
                where endpoint = 'https://push.example/bbb'),
    'and cannot see the admin''s device');

  -- No error: the row is invisible, so the delete matches nothing. That is the
  -- shape worth asserting — "it threw" would pass for the wrong reason.
  delete from public.push_subscriptions where endpoint = 'https://push.example/bbb';
  get diagnostics changed = row_count;
  perform public.assert(changed = 0, 'nor unsubscribe somebody else''s phone');

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values ('a0000000-0000-0000-0000-000000000001', 'https://push.example/ccc', 'k3', 'a3');
  perform public.assert(
    (select count(*) from public.push_subscriptions) = 2,
    'but may register a second device of their own');

  reset role;
end $$;

do $$
declare
  refused boolean := false;
begin
  raise notice 'push — a row cannot be addressed to somebody else';
  call auth.login_as('a0000000-0000-0000-0000-000000000001');
  begin
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
    values ('a0000000-0000-0000-0000-000000000002', 'https://push.example/ddd', 'k4', 'a4');
  exception when insufficient_privilege then
    refused := true;
  end;
  reset role;
  perform public.assert(refused,
    'a student cannot subscribe the admin''s account to their own device');
end $$;

do $$
begin
  raise notice 'push — not even staff read other people''s devices';
  call auth.login_as('a0000000-0000-0000-0000-000000000002');
  perform public.assert(
    (select count(*) from public.push_subscriptions) = 1,
    'the admin sees their own device only — there is no staff-read policy here');
  reset role;
end $$;

\echo 'ALL SITE CONTENT TESTS PASSED'
