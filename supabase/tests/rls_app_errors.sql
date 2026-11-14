-- ---------------------------------------------------------------------------
-- The crash log is readable by staff and writable by nobody.
--
-- This table exists so an error code shown on a page can be turned back into
-- the message the server saw. That means it holds stack frames and internal
-- file paths — useful to an admin, and exactly the sort of thing that must not
-- be readable by a student or writable by anyone at all.
--
-- Three properties, each proved rather than assumed:
--
--   1. A student and an instructor read ZERO rows. Not "an error" — zero, which
--      is what a select policy that does not match looks like from outside.
--   2. NOBODY writes through the API. There is no insert, update or delete
--      policy on the table, so every direct write is refused regardless of who
--      asks. The definer function is the only door.
--   3. That door works for a logged-out caller, because a crash happens to
--      whoever was on the page and an anonymous visitor hitting a broken
--      catalogue is precisely the report that was going missing.
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

\echo ''
\echo '=== the crash log ==='

-- --- fixtures -------------------------------------------------------------
--
-- `profiles` rows are created by the trigger on `auth.users`, so the users come
-- first and the roles are set afterwards.

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000001', 'student@test.fr',    '{"full_name":"Étudiante"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000002', 'admin@test.fr',      '{"full_name":"Direction"}'::jsonb),
  ('a0000000-0000-0000-0000-000000000003', 'instructor@test.fr', '{"full_name":"Enseignant"}'::jsonb);

update public.profiles set role = 'admin'
  where id = 'a0000000-0000-0000-0000-000000000002';
update public.profiles set role = 'instructor'
  where id = 'a0000000-0000-0000-0000-000000000003';

-- --- the door ---------------------------------------------------------------

do $$
begin
  raise notice 'errors — an anonymous caller can file a report';
  -- No login_as: this is a logged-out visitor, whose crashes were the ones
  -- nobody was hearing about.
  perform public.record_app_error(
    '/[locale]/courses/[slug]', '2825006692', 'TypeError', 'boom', 'at Foo (x.tsx:1:1)');
  perform public.assert(
    (select count(*) from public.app_errors where digest = '2825006692') = 1,
    'the definer function accepts a report from anon');
end $$;

do $$
begin
  raise notice 'errors — the fields are truncated by the function, not the caller';
  perform public.record_app_error(
    repeat('r', 500), repeat('d', 500), repeat('n', 500), repeat('m', 5000), repeat('s', 5000));
  perform public.assert(
    (select length(message) from public.app_errors where name = repeat('n', 100)) = 2000,
    'a giant message is cut to 2000 rather than raising on the failing path');
  perform public.assert(
    (select length(route) from public.app_errors where name = repeat('n', 100)) = 200,
    'the route is cut to 200');
end $$;

-- --- who may read -----------------------------------------------------------

do $$
begin
  raise notice 'errors — a student reads nothing';
  call auth.login_as('a0000000-0000-0000-0000-000000000001');
  perform public.assert(
    (select count(*) from public.app_errors) = 0,
    'a student sees zero rows — stack traces are not theirs');
  reset role;
end $$;

do $$
begin
  raise notice 'errors — an instructor reads nothing either';
  call auth.login_as('a0000000-0000-0000-0000-000000000003');
  perform public.assert(
    (select count(*) from public.app_errors) = 0,
    'the policy is is_admin(), not is_staff() — an instructor is staff and still sees none');
  reset role;
end $$;

do $$
begin
  raise notice 'errors — the admin reads them';
  call auth.login_as('a0000000-0000-0000-0000-000000000002');
  perform public.assert(
    (select count(*) from public.app_errors) = 2,
    'the admin sees every recorded error');
  perform public.assert(
    (select message from public.app_errors where digest = '2825006692') = 'boom',
    'a digest off an error page resolves to the message the server saw');
  reset role;
end $$;

-- --- who may write ----------------------------------------------------------

do $$
declare refused boolean := false;
begin
  raise notice 'errors — a student cannot forge a report';
  call auth.login_as('a0000000-0000-0000-0000-000000000001');
  begin
    insert into public.app_errors (route, digest, message) values ('/x', 'forged', 'hi');
  exception when insufficient_privilege then
    refused := true;
  end;
  reset role;
  perform public.assert(refused, 'a direct insert is refused: there is no insert policy');
end $$;

do $$
declare refused boolean := false;
begin
  raise notice 'errors — not even the admin writes directly';
  call auth.login_as('a0000000-0000-0000-0000-000000000002');
  begin
    insert into public.app_errors (route, digest, message) values ('/x', 'forged', 'hi');
  exception when insufficient_privilege then
    refused := true;
  end;
  reset role;
  perform public.assert(refused,
    'reading is an admin right; writing belongs to the function alone');
end $$;

do $$
declare refused boolean := false;
begin
  raise notice 'errors — an admin cannot quietly edit the record away';
  call auth.login_as('a0000000-0000-0000-0000-000000000002');
  begin
    update public.app_errors set message = 'nothing to see';
  exception when insufficient_privilege then
    refused := true;
  end;
  reset role;
  -- An update with no policy affects zero rows rather than raising, so both
  -- outcomes are accepted — what must not happen is the message changing.
  perform public.assert(
    refused or (select message from public.app_errors where digest = '2825006692') = 'boom',
    'the recorded message survives an attempt to overwrite it');
end $$;

-- --- it cannot grow ---------------------------------------------------------

do $$
begin
  raise notice 'errors — the table is capped at 200 rows';
  for i in 1..220 loop
    perform public.record_app_error('/[locale]/x', 'd' || i, 'Error', 'm' || i, '');
  end loop;
  perform public.assert(
    (select count(*) from public.app_errors) = 200,
    'the newest 200 are kept, so a crash loop cannot fill the free tier');
  perform public.assert(
    (select count(*) from public.app_errors where digest = 'd220') = 1,
    'and it is the NEWEST that survive, not the oldest');
end $$;

\echo 'ALL CRASH LOG TESTS PASSED'
