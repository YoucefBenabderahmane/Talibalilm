-- ---------------------------------------------------------------------------
-- Spam that confirms its e-mail is cleaned up; real students never are.
--
-- `unreviewed_unpaid_users` is the list the sweep turns into DELETED accounts,
-- so what matters most is what it leaves out. The spam is modelled on the real
-- October 2026 rows: confirmed within seconds, never « Confirmer »-ed by the
-- office, never bought.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

create or replace function public.assert(ok boolean, what text)
returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', what; end if;
  raise notice '  ok  %', what;
end $$;

-- Every account is confirmed: that is the spam this list exists for.
insert into auth.users (id, email, raw_user_meta_data, created_at, email_confirmed_at) values
  ('c0000000-0000-4000-8000-000000000001', 'sunwin@gmail.com',   '{"full_name":"Sunwin"}',
   now() - interval '4 days', now() - interval '4 days'),
  ('c0000000-0000-4000-8000-000000000002', 'fresh@gmail.com',    '{"full_name":"Fresh Spam"}',
   now() - interval '2 days', now() - interval '2 days'),
  ('c0000000-0000-4000-8000-000000000003', 'reviewed@gmail.com', '{"full_name":"Pape Ousmane BA"}',
   now() - interval '4 days', now() - interval '4 days'),
  ('c0000000-0000-4000-8000-000000000004', 'buyer@gmail.com',    '{"full_name":"Amina Buyer"}',
   now() - interval '4 days', now() - interval '4 days'),
  ('c0000000-0000-4000-8000-000000000005', 'granted@gmail.com',  '{"full_name":"Sihem Granted"}',
   now() - interval '4 days', now() - interval '4 days'),
  ('c0000000-0000-4000-8000-000000000006', 'admin@test.fr',      '{"full_name":"La Direction"}',
   now() - interval '4 days', now() - interval '4 days'),
  ('c0000000-0000-4000-8000-000000000007', 'prof@test.fr',       '{"full_name":"Un Enseignant"}',
   now() - interval '4 days', now() - interval '4 days');

-- The trigger made every profile "new". Mark one as confirmed by the office,
-- and two as staff.
update public.profiles set reviewed_at = null;
update public.profiles set reviewed_at = now()
  where id = 'c0000000-0000-4000-8000-000000000003';
update public.profiles set role = 'admin'
  where id = 'c0000000-0000-4000-8000-000000000006';
update public.profiles set role = 'instructor'
  where id = 'c0000000-0000-4000-8000-000000000007';

-- A sale at the desk, and an access granted by hand without any order.
insert into public.orders (id, user_id, route, delivery) values
  ('c1110000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000004',
   'office', 'presentiel');
insert into public.entitlements (user_id, scope, expires_at) values
  ('c0000000-0000-4000-8000-000000000005', 'site', now() + interval '1 year');

\echo ''
\echo '=== spam that confirms its e-mail ==='

do $$
declare ids uuid[];
begin
  raise notice 'the list holds the spam and nothing else';
  execute 'set local role service_role';
  select array_agg(id order by id) into ids
    from public.unreviewed_unpaid_users(interval '3 days');
  execute 'reset role';

  perform public.assert(
    coalesce(ids, '{}') = array['c0000000-0000-4000-8000-000000000001'::uuid],
    'only the four-day-old, never-confirmed-by-the-office, never-paid account is listed');
end $$;

do $$
declare ids uuid[];
begin
  raise notice 'and each exclusion holds on its own';
  execute 'set local role service_role';
  select array_agg(id) into ids from public.unreviewed_unpaid_users(interval '3 days');
  execute 'reset role';
  ids := coalesce(ids, '{}');

  perform public.assert(not 'c0000000-0000-4000-8000-000000000002'::uuid = any(ids),
    'two days old: still inside the three days the office has');
  perform public.assert(not 'c0000000-0000-4000-8000-000000000003'::uuid = any(ids),
    'the office pressed « Confirmer »: never deleted');
  perform public.assert(not 'c0000000-0000-4000-8000-000000000004'::uuid = any(ids),
    'an order, even unpaid at the desk: never deleted');
  perform public.assert(not 'c0000000-0000-4000-8000-000000000005'::uuid = any(ids),
    'access granted by hand without an order: never deleted');
  perform public.assert(not 'c0000000-0000-4000-8000-000000000006'::uuid = any(ids),
    'an admin: never deleted');
  perform public.assert(not 'c0000000-0000-4000-8000-000000000007'::uuid = any(ids),
    'an instructor: never deleted');
end $$;

do $$
declare refused boolean;
begin
  raise notice 'nobody but the service role may ask for it';
  perform public.assert(
    not has_function_privilege('anon', 'public.unreviewed_unpaid_users(interval)', 'execute'),
    'anon cannot list accounts (it returns e-mail addresses)');
  perform public.assert(
    not has_function_privilege('authenticated', 'public.unreviewed_unpaid_users(interval)', 'execute'),
    'a signed-in user cannot');
  perform public.assert(
    not has_function_privilege('anon', 'public.unconfirmed_users(interval)', 'execute'),
    'nor can anon call the older unconfirmed list');

  refused := false;
  call auth.login_as('c0000000-0000-4000-8000-000000000001');
  begin
    perform public.unreviewed_unpaid_users(interval '3 days');
  exception when insufficient_privilege then refused := true;
  end;
  execute 'reset role';
  perform public.assert(refused, 'the spam account itself is refused');
end $$;

\echo 'ALL UNREVIEWED CLEANUP TESTS PASSED'
