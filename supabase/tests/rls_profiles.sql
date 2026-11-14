-- ---------------------------------------------------------------------------
-- Policy tests for `profiles`.
--
-- Run against a scratch database that has 00_local_harness.sql and the
-- migrations applied. Any failure raises, so psql -v ON_ERROR_STOP=1 exits
-- non-zero and CI notices.
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
-- Inserted into auth.users so the signup trigger does the provisioning, which
-- is what production does. Nothing writes to public.profiles directly.

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'student@test.fr',
   '{"full_name":"Étudiante Test","locale":"fr"}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'other@test.fr',
   '{"full_name":"Autre Étudiante","locale":"en"}'::jsonb),
  ('33333333-3333-3333-3333-333333333333', 'teacher@test.fr',
   '{"full_name":"Sihem","locale":"fr"}'::jsonb),
  -- Hostile metadata: the client controls this blob at signup, so it tries to
  -- claim admin and an unknown locale in one go.
  ('44444444-4444-4444-4444-444444444444', 'attacker@test.fr',
   '{"full_name":"Attaquant","locale":"xx","role":"admin"}'::jsonb);

-- Promote the teacher the way an admin action would: service-role, not client.
update public.profiles set role = 'instructor'
  where id = '33333333-3333-3333-3333-333333333333';

do $$
begin
  raise notice 'provisioning';

  perform public.assert(
    (select count(*) from public.profiles) = 4,
    'the signup trigger creates exactly one profile per auth user');

  perform public.assert(
    (select full_name from public.profiles where id = '11111111-1111-1111-1111-111111111111')
      = 'Étudiante Test',
    'full_name is carried across from signup metadata');

  perform public.assert(
    (select locale from public.profiles where id = '22222222-2222-2222-2222-222222222222') = 'en',
    'a valid locale in metadata is honoured');

  perform public.assert(
    (select locale from public.profiles where id = '44444444-4444-4444-4444-444444444444') = 'fr',
    'an unknown locale in metadata falls back to fr instead of failing signup');

  perform public.assert(
    (select role from public.profiles where id = '44444444-4444-4444-4444-444444444444') = 'student',
    'role in signup metadata is ignored — everyone starts as a student');
end $$;

-- --- reads ----------------------------------------------------------------

do $$
declare visible int;
begin
  raise notice 'reads';

  call auth.login_as('11111111-1111-1111-1111-111111111111');
  select count(*) into visible from public.profiles;
  perform public.assert(visible = 1, 'a student sees only their own profile');

  perform public.assert(
    (select count(*) from public.profiles
      where id = '22222222-2222-2222-2222-222222222222') = 0,
    'a student cannot read another student by id');

  call auth.login_as('33333333-3333-3333-3333-333333333333');
  select count(*) into visible from public.profiles;
  perform public.assert(visible = 4, 'an instructor sees every profile');

  reset role;
end $$;

do $$
declare denied boolean := false;
begin
  -- `anon` holds no grant on profiles at all, so the read is refused before
  -- any policy is consulted. Stronger than an empty result set: there is no
  -- query shape a signed-out visitor can use to probe the table.
  call auth.logout();
  begin
    perform count(*) from public.profiles;
  exception when insufficient_privilege then
    denied := true;
  end;
  perform public.assert(denied,
    'an anonymous visitor is refused the profiles table outright');

  reset role;
end $$;

-- --- writes ---------------------------------------------------------------

do $$
declare escalated boolean := false;
begin
  raise notice 'writes';

  call auth.login_as('11111111-1111-1111-1111-111111111111');

  update public.profiles set full_name = 'Nom Corrigé'
    where id = '11111111-1111-1111-1111-111111111111';
  perform public.assert(
    (select full_name from public.profiles
      where id = '11111111-1111-1111-1111-111111111111') = 'Nom Corrigé',
    'a student can edit their own name');

  update public.profiles set full_name = 'Piraté'
    where id = '22222222-2222-2222-2222-222222222222';
  perform public.assert(not found, 'a student cannot edit another profile');

  -- The checkout's enrolment form writes these. Each new column needs its own
  -- UPDATE grant or the form silently saves nothing.
  update public.profiles
     set civility = 'madame',
         first_name = 'Amina',
         last_name = 'B.',
         phone = '0611223344',
         phone_landline = '0134567890',
         birth_date = '1995-10-03',
         address = '1 rue de la Mosquée',
         postal_code = '77130',
         city = 'Montereau-Fault-Yonne',
         department = 'sciences-islamiques'
   where id = '11111111-1111-1111-1111-111111111111';
  perform public.assert(
    (select first_name = 'Amina' and last_name = 'B.' and city = 'Montereau-Fault-Yonne'
        and department = 'sciences-islamiques' and birth_date = date '1995-10-03'
     from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
    'a student can fill in their own enrolment details');

  -- Shape enforced in the database as well as the form: civility is a value
  -- the office groups by, not free text.
  begin
    update public.profiles set civility = 'docteur'
      where id = '11111111-1111-1111-1111-111111111111';
    escalated := true;
  exception when check_violation then
    escalated := false;
  end;
  perform public.assert(not escalated,
    'civility only accepts madame or monsieur');

  -- The photo is stored as an R2 key, and the key's shape is a security rule:
  -- the user id is its prefix, so a key naming somebody else's object is not
  -- one this row could hold even if a caller crafted it.
  update public.profiles
     set avatar_key = 'avatars/11111111-1111-1111-1111-111111111111/abcdef1234567890.jpg'
   where id = '11111111-1111-1111-1111-111111111111';
  perform public.assert(
    (select avatar_key is not null from public.profiles
      where id = '11111111-1111-1111-1111-111111111111'),
    'a student can set their own photo key');

  begin
    update public.profiles
       set avatar_key = 'avatars/22222222-2222-2222-2222-222222222222/abcdef1234567890.jpg'
     where id = '11111111-1111-1111-1111-111111111111';
    escalated := true;
  exception when check_violation then
    escalated := false;
  end;
  perform public.assert(not escalated,
    'a photo key under another student''s prefix is refused by the shape constraint');

  -- THE one that matters. RLS alone would allow this: the row still belongs to
  -- the caller, so `using (id = auth.uid())` passes. Only the column grant
  -- stops it.
  begin
    update public.profiles set role = 'admin'
      where id = '11111111-1111-1111-1111-111111111111';
    escalated := true;
  exception when insufficient_privilege then
    escalated := false;
  end;
  perform public.assert(not escalated,
    'a student CANNOT promote themselves to admin (column grant holds)');

  -- The belt behind that column grant: even if a future migration granted
  -- UPDATE(role) by mistake, the trigger refuses a session. This test grants
  -- it on purpose, to prove the second lock is there.
  grant update (role) on public.profiles to authenticated;
  begin
    update public.profiles set role = 'admin'
      where id = '11111111-1111-1111-1111-111111111111';
    escalated := true;
  exception when insufficient_privilege then
    escalated := false;
  end;
  revoke update (role) on public.profiles from authenticated;
  perform public.assert(not escalated,
    'and a session cannot write a role even WITH the column grant — the trigger refuses');

  perform public.assert(
    (select role from public.profiles
      where id = '11111111-1111-1111-1111-111111111111') = 'student',
    'role is unchanged after the escalation attempt');

  reset role;
end $$;

do $$
declare
  inserted boolean := false;
  deleted boolean := false;
begin
  raise notice 'inserts and deletes';

  call auth.login_as('11111111-1111-1111-1111-111111111111');

  begin
    insert into public.profiles (id, full_name) values (gen_random_uuid(), 'Faux');
    inserted := true;
  exception when insufficient_privilege or check_violation then
    inserted := false;
  end;
  perform public.assert(not inserted,
    'a client cannot insert a profile — rows arrive by trigger only');

  -- Like the anon read, this is refused for want of a grant rather than by a
  -- policy returning nothing. A student has no DELETE privilege on the table
  -- at all, so there is no row they can aim it at.
  begin
    delete from public.profiles where id = '11111111-1111-1111-1111-111111111111';
    deleted := true;
  exception when insufficient_privilege then
    deleted := false;
  end;
  perform public.assert(not deleted,
    'a client cannot delete a profile — rows leave by cascade only');

  reset role;
end $$;

do $$
begin
  raise notice 'cascade';
  delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
  perform public.assert(
    (select count(*) from public.profiles
      where id = '11111111-1111-1111-1111-111111111111') = 0,
    'deleting the auth user cascades the profile away (GDPR erasure)');
end $$;

drop function public.assert(boolean, text);

\echo ''
\echo 'ALL PROFILE POLICY TESTS PASSED'
