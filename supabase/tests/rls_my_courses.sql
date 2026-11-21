-- ---------------------------------------------------------------------------
-- "Mes formations" lists what the paywall would open, and nothing else.
--
-- `my_course_ids()` is what the dashboard reads to show a student the modules
-- they hold. It must agree with `has_course_access` for every kind of holder —
-- a module bought outright, a year of a cursus — and it must answer nothing
-- to a stranger, to an expired access and to a signed-out
-- visitor. A card for a course the lessons then refuse would be a lie on the
-- student's own page.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

create or replace function public.assert(ok boolean, what text)
returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', what; end if;
  raise notice '  ok  %', what;
end $$;
grant execute on function public.assert(boolean, text) to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-4000-8000-000000000001', 'module@test.fr',   '{"full_name":"Module"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000002', 'cursus@test.fr',   '{"full_name":"Cursus"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000003', 'expired@test.fr',  '{"full_name":"Expire"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000004', 'stranger@test.fr', '{"full_name":"Etranger"}'::jsonb);

insert into public.courses (id, slug, title, status, published_at) values
  ('c0000000-0000-4000-8000-000000000001', 'fiqh',    'Fiqh',    'published', now()),
  ('c0000000-0000-4000-8000-000000000002', 'aqida',   'Aqida',   'published', now()),
  ('c0000000-0000-4000-8000-000000000003', 'tajwid',  'Tajwid',  'published', now()),
  ('c0000000-0000-4000-8000-000000000004', 'hadith',  'Hadith',  'published', now()),
  ('c0000000-0000-4000-8000-000000000005', 'secret',  'Secret',  'draft',     null);

insert into public.cursus (id, slug, kind, title, year_count, status) values
  ('f0000000-0000-4000-8000-000000000001', 'fixture-approfondi', 'approfondi',
   'Cursus Approfondi', 2, 'published');

-- Year 1 covers Aqida and Tajwid online and Fiqh on site; year 2 covers
-- Hadith. A draft course sits in year 1 as well. `has_course_access` opens a
-- cursus by YEAR (the delivery mode stopped narrowing it with the instalment
-- migration), so the list must follow the same rule and not a stricter one.
insert into public.cursus_courses (cursus_id, course_id, delivery, year_index, position) values
  ('f0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'online', 1, 1),
  ('f0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', 'online', 1, 2),
  ('f0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000005', 'online', 1, 3),
  ('f0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000004', 'online', 2, 1),
  ('f0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'presentiel', 1, 1);

insert into public.entitlements
  (user_id, scope, course_id, cursus_id, year_index, delivery, expires_at) values
  -- Bought the Fiqh module outright.
  ('a0000000-0000-4000-8000-000000000001', 'course', 'c0000000-0000-4000-8000-000000000001',
   null, 1, 'online', now() + interval '300 days'),
  -- Year 1 of the online cursus.
  ('a0000000-0000-4000-8000-000000000002', 'cursus', null,
   'f0000000-0000-4000-8000-000000000001', 1, 'online', now() + interval '300 days');

-- An access that ran out yesterday, still marked active: the clock decides.
insert into public.entitlements
  (user_id, scope, course_id, cursus_id, year_index, delivery, starts_at, expires_at) values
  ('a0000000-0000-4000-8000-000000000003', 'course', 'c0000000-0000-4000-8000-000000000001',
   null, 1, 'online', now() - interval '366 days', now() - interval '1 day');

\echo ''
\echo '=== my_course_ids ==='

do $$
declare got uuid[];
begin
  call auth.login_as('a0000000-0000-4000-8000-000000000001');
  select coalesce(array_agg(id order by id), '{}') into got from public.my_course_ids() as id;
  perform public.assert(
    got = array['c0000000-0000-4000-8000-000000000001']::uuid[],
    'a module buyer is listed their module, and only it');
  reset role;

  call auth.login_as('a0000000-0000-4000-8000-000000000002');
  select coalesce(array_agg(id order by id), '{}') into got from public.my_course_ids() as id;
  perform public.assert(
    got = array['c0000000-0000-4000-8000-000000000001',
                'c0000000-0000-4000-8000-000000000002',
                'c0000000-0000-4000-8000-000000000003']::uuid[],
    'a cursus buyer is listed every published module of their own year');
  perform public.assert(
    not ('c0000000-0000-4000-8000-000000000004' = any (got)),
    'not the modules of another year');
  perform public.assert(
    not ('c0000000-0000-4000-8000-000000000005' = any (got)),
    'and not a course that is still a draft');
  reset role;

  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  select coalesce(array_agg(id order by id), '{}') into got from public.my_course_ids() as id;
  perform public.assert(got = '{}'::uuid[], 'an access that has run out lists nothing');
  reset role;

  call auth.login_as('a0000000-0000-4000-8000-000000000004');
  select coalesce(array_agg(id order by id), '{}') into got from public.my_course_ids() as id;
  perform public.assert(got = '{}'::uuid[], 'somebody who holds nothing is listed nothing');
  reset role;
end $$;

do $$
begin
  -- Every listed course is one the paywall opens: the list and the gate are
  -- the same answer, for each of the holders above.
  call auth.login_as('a0000000-0000-4000-8000-000000000002');
  perform public.assert(
    not exists (
      select 1 from public.my_course_ids() as id
       where not public.has_course_access(id)
    ),
    'every listed course is one has_course_access opens');
  perform public.assert(
    not exists (
      select 1 from public.courses c
       where c.status = 'published'
         and public.has_course_access(c.id)
         and c.id not in (select public.my_course_ids())
    ),
    'and every published course it opens is listed');
  reset role;
end $$;

do $$
begin
  perform public.assert(
    not has_function_privilege('anon', 'public.my_course_ids()', 'execute'),
    'a signed-out visitor cannot call it');
  perform public.assert(
    has_function_privilege('authenticated', 'public.my_course_ids()', 'execute'),
    'a signed-in student can');
end $$;

\echo ''
\echo 'my_course_ids: all assertions passed'
