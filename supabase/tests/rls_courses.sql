-- ---------------------------------------------------------------------------
-- Policy tests for the teaching schema.
--
-- This is the file that decides whether the rebuild actually fixed anything.
-- The old site's security was "the plugin hides the button"; these assert that
-- the DATABASE refuses, so a hand-crafted query, a direct API call or a bug in
-- the UI all hit the same wall.
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
  ('a0000000-0000-0000-0000-000000000001', 'nomember@test.fr', '{"full_name":"Sans abonnement"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000002', 'member@test.fr',   '{"full_name":"Abonnée"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000003', 'expired@test.fr',  '{"full_name":"Expirée"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000004', 'teacher@test.fr',  '{"full_name":"Sihem"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000005', 'stale@test.fr',    '{"full_name":"Périmée non balayée"}'::jsonb);

update public.profiles set role = 'instructor'
  where id = 'a0000000-0000-0000-0000-000000000004';

-- Site-scope entitlements: the shape the old single membership had. This file
-- keeps testing the CONTENT gate — preview, publication, staff, the clock —
-- with the simplest possible grant. rls_commerce.sql tests the per-course and
-- per-cursus scoping that replaced it.
insert into public.entitlements (user_id, scope, status, starts_at, expires_at) values
  ('a0000000-0000-0000-0000-000000000002', 'site', 'active',
   now() - interval '165 days', now() + interval '200 days'),
  ('a0000000-0000-0000-0000-000000000003', 'site', 'expired',
   now() - interval '375 days', now() - interval '10 days'),
  -- Still flagged active but past its date: the nightly sweep has not run yet.
  -- The gate must refuse this on the clock alone.
  ('a0000000-0000-0000-0000-000000000005', 'site', 'active',
   now() - interval '366 days', now() - interval '1 day');

insert into public.courses (id, slug, title, title_ar, status, published_at, instructor_id) values
  ('c0000000-0000-0000-0000-000000000001', 'fiqh-al-ibadat', 'Jurisprudence islamique',
   'فقه العبادات', 'published', now(), 'a0000000-0000-0000-0000-000000000004'),
  ('c0000000-0000-0000-0000-000000000002', 'cours-brouillon', 'Cours en préparation',
   'مسودة', 'draft', null, 'a0000000-0000-0000-0000-000000000004');

insert into public.modules (id, course_id, title, position) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'At-Tahāra', 1),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'Module caché', 1);

insert into public.lessons (id, module_id, title, slug, position, duration_seconds, is_preview) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Les eaux et les impuretés', 'les-eaux', 1, 2520, true),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
   'Les ablutions', 'les-ablutions', 2, 3300, false),
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000002',
   'Leçon en brouillon', 'brouillon', 1, 1200, true);

insert into public.lesson_content (lesson_id, content, video_provider, video_id) values
  ('e0000000-0000-0000-0000-000000000001', 'Extrait gratuit.', 'bunny', 'PREVIEW-VIDEO-ID'),
  ('e0000000-0000-0000-0000-000000000002', 'Corps de la leçon réservée.', 'bunny', 'SECRET-VIDEO-ID'),
  ('e0000000-0000-0000-0000-000000000003', 'Brouillon.', 'bunny', 'DRAFT-VIDEO-ID');

-- --- the catalogue is public ----------------------------------------------

do $$
begin
  raise notice 'public catalogue';
  call auth.logout();

  perform public.assert((select count(*) from public.courses) = 1,
    'an anonymous visitor sees published courses only');
  perform public.assert(
    (select count(*) from public.courses where slug = 'cours-brouillon') = 0,
    'a draft course is invisible to the public');
  perform public.assert((select count(*) from public.modules) = 1,
    'modules of a draft course are invisible too');
  perform public.assert((select count(*) from public.lessons) = 2,
    'lesson TITLES of a published course are public — the syllabus is the sales page');
  perform public.assert(
    (select title from public.lessons where slug = 'les-ablutions') = 'Les ablutions',
    'a locked lesson still shows its title and duration');
  perform public.assert(
    (select count(*) from public.lessons where slug = 'brouillon') = 0,
    'lessons of a draft course are invisible');

  reset role;
end $$;

-- --- THE GATE -------------------------------------------------------------

do $$
declare leaked text;
begin
  raise notice 'the gate — anonymous';
  call auth.logout();

  perform public.assert((select count(*) from public.lesson_content) = 1,
    'an anonymous visitor reaches exactly one lesson_content row: the preview');

  perform public.assert(
    (select content from public.lesson_content
      where lesson_id = 'e0000000-0000-0000-0000-000000000001') = 'Extrait gratuit.',
    'the free preview IS readable without an account');

  select video_id into leaked from public.lesson_content
    where lesson_id = 'e0000000-0000-0000-0000-000000000002';
  perform public.assert(leaked is null,
    'the gated lesson''s video_id is UNREACHABLE anonymously');

  perform public.assert(
    (select count(*) from public.lesson_content
      where video_id = 'SECRET-VIDEO-ID') = 0,
    'not even a direct query BY the secret video id returns it');

  perform public.assert(
    (select count(*) from public.lesson_content
      where lesson_id = 'e0000000-0000-0000-0000-000000000003') = 0,
    'a draft course''s content is unreachable even though its lesson is flagged preview');

  reset role;
end $$;

do $$
declare leaked text;
begin
  raise notice 'the gate — signed in, no membership';
  call auth.login_as('a0000000-0000-0000-0000-000000000001');

  perform public.assert((select count(*) from public.lessons) = 2,
    'a signed-in non-member still sees the syllabus');

  select content into leaked from public.lesson_content
    where lesson_id = 'e0000000-0000-0000-0000-000000000002';
  perform public.assert(leaked is null,
    'having an ACCOUNT is not having a MEMBERSHIP — content still refused');

  perform public.assert((select count(*) from public.lesson_content) = 1,
    'a non-member reaches the preview and nothing else');

  reset role;
end $$;

do $$
begin
  raise notice 'the gate — expired and stale entitlements';

  call auth.login_as('a0000000-0000-0000-0000-000000000003');
  perform public.assert((select count(*) from public.lesson_content) = 1,
    'an EXPIRED entitlement grants nothing beyond the preview');
  reset role;

  -- The one that a status-column-only check would get wrong.
  call auth.login_as('a0000000-0000-0000-0000-000000000005');
  perform public.assert((select count(*) from public.lesson_content) = 1,
    'a row still marked active but past expires_at grants nothing — the clock decides, not the flag');
  reset role;
end $$;

do $$
begin
  raise notice 'the gate — active member';
  call auth.login_as('a0000000-0000-0000-0000-000000000002');

  perform public.assert((select count(*) from public.lesson_content) = 2,
    'an active member reaches every lesson of every published course');
  perform public.assert(
    (select video_id from public.lesson_content
      where lesson_id = 'e0000000-0000-0000-0000-000000000002') = 'SECRET-VIDEO-ID',
    'a member gets the video id — one membership unlocks everything');
  perform public.assert(
    (select count(*) from public.lesson_content
      where lesson_id = 'e0000000-0000-0000-0000-000000000003') = 0,
    'not even a member sees an unpublished course');

  reset role;
end $$;

do $$
begin
  raise notice 'the gate — staff';
  call auth.login_as('a0000000-0000-0000-0000-000000000004');

  perform public.assert((select count(*) from public.courses) = 2,
    'an instructor sees drafts, which is how the builder works at all');
  perform public.assert((select count(*) from public.lesson_content) = 3,
    'an instructor reaches all content without needing to buy a membership');

  reset role;
end $$;

-- --- writes ---------------------------------------------------------------

do $$
declare wrote boolean := false;
begin
  raise notice 'progress and enrolment';

  call auth.login_as('a0000000-0000-0000-0000-000000000001');
  begin
    insert into public.lesson_progress (user_id, lesson_id, status)
    values ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002', 'in_progress');
    wrote := true;
  exception when insufficient_privilege then wrote := false;
  end;
  perform public.assert(not wrote, 'a non-member cannot record progress');
  reset role;

  call auth.login_as('a0000000-0000-0000-0000-000000000002');
  insert into public.lesson_progress (user_id, lesson_id, status)
  values ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002', 'in_progress');
  perform public.assert((select count(*) from public.lesson_progress) = 1,
    'a member records their own progress');

  wrote := false;
  begin
    insert into public.lesson_progress (user_id, lesson_id, status)
    values ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'completed');
    wrote := true;
  exception when insufficient_privilege then wrote := false;
  end;
  perform public.assert(not wrote, 'a member cannot write progress on someone else''s behalf');
  reset role;
end $$;

do $$
declare wrote boolean := false;
begin
  raise notice 'authoring';

  call auth.login_as('a0000000-0000-0000-0000-000000000002');
  begin
    update public.courses set title = 'Détourné'
      where id = 'c0000000-0000-0000-0000-000000000001';
    wrote := found;
  exception when insufficient_privilege then wrote := false;
  end;
  perform public.assert(not wrote, 'a member cannot edit a course');

  wrote := false;
  begin
    update public.lesson_content set content = 'Détourné'
      where lesson_id = 'e0000000-0000-0000-0000-000000000002';
    wrote := found;
  exception when insufficient_privilege then wrote := false;
  end;
  perform public.assert(not wrote, 'a member cannot edit lesson content they can read');
  reset role;

  call auth.login_as('a0000000-0000-0000-0000-000000000004');
  update public.courses set subtitle = 'Modifié par l''enseignante'
    where id = 'c0000000-0000-0000-0000-000000000001';
  perform public.assert(found, 'an instructor can edit a course');
  reset role;
end $$;

do $$
begin
  raise notice 'entitlement integrity';
  call auth.login_as('a0000000-0000-0000-0000-000000000001');

  perform public.assert((select count(*) from public.entitlements) = 0,
    'a member cannot see anyone else''s entitlement, nor invent their own');

  reset role;
end $$;

do $$
declare granted boolean := false;
begin
  call auth.login_as('a0000000-0000-0000-0000-000000000001');
  begin
    insert into public.entitlements (user_id, scope, expires_at)
    values ('a0000000-0000-0000-0000-000000000001', 'site', now() + interval '365 days');
    granted := true;
  exception when insufficient_privilege then granted := false;
  end;
  perform public.assert(not granted,
    'a user CANNOT grant themselves an entitlement — no insert privilege exists at all');
  reset role;
end $$;

drop function public.assert(boolean, text);

\echo ''
\echo 'ALL COURSE POLICY TESTS PASSED'
