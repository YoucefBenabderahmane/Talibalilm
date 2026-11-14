-- ---------------------------------------------------------------------------
-- Erasure that keeps the books (audit B9).
--
-- A student asks to be forgotten; the school must keep its sales records. These
-- assertions prove the two do not collide: anonymisation scrubs the person from
-- the profile and ends their access, the orders stay because `user_id` is
-- `on delete restrict`, and the whole thing is admin-only, reason-required and
-- on the audit trail — the same discipline as every other office operation.
--
-- The auth.users half (email, login) is scrubbed by the service-role Admin API
-- from the server action, not reachable here; this file proves the public-schema
-- half the database owns.
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

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-4000-8000-000000000001', 'student@test.fr', '{"full_name":"Étudiant Réel"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000002', 'prof@test.fr',    '{"full_name":"Professeur"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000003', 'admin@test.fr',   '{"full_name":"Direction"}'::jsonb);
update public.profiles set role = 'instructor' where id = 'a0000000-0000-4000-8000-000000000002';
update public.profiles set role = 'admin' where id = 'a0000000-0000-4000-8000-000000000003';
update public.profiles
   set phone = '+33600000000',
       civility = 'monsieur',
       first_name = 'Étudiant',
       last_name = 'Réel',
       phone_landline = '+33100000000',
       birth_date = '1995-10-03',
       address = '1 rue de la Mosquée',
       postal_code = '77130',
       city = 'Montereau-Fault-Yonne',
       department = 'sciences-islamiques',
       avatar_key = 'avatars/a0000000-0000-4000-8000-000000000001/abcdef1234567890.jpg'
 where id = 'a0000000-0000-4000-8000-000000000001';

insert into public.courses (id, slug, title, status, published_at) values
  ('c0000000-0000-4000-8000-000000000001', 'fiqh', 'Fiqh', 'published', now());

insert into public.products (id, kind, course_id, delivery, time_slot, price_cents, status)
values ('11110000-0000-4000-8000-000000000001', 'module',
        'c0000000-0000-4000-8000-000000000001', 'online', 'semaine-soir', 30000, 'published');

-- A paid order the student placed. This is what must survive the erasure.
insert into public.orders
  (id, user_id, route, delivery, subtotal_cents, total_cents, status, paid_at)
values ('33330000-0000-4000-8000-000000000001',
        'a0000000-0000-4000-8000-000000000001', 'paypal', 'online', 30000, 30000, 'paid', now());
insert into public.order_items
  (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
values ('33330000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
        'module', 'c0000000-0000-4000-8000-000000000001', 'online', 30000, 365);

\echo ''
\echo '=== gdpr anonymisation ==='

-- Give the student live access to prove erasure ends it.
do $$
begin
  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  perform public.admin_grant_entitlement(
    'a0000000-0000-4000-8000-000000000001', 'course',
    'c0000000-0000-4000-8000-000000000001', null, 1, 'online', 365, 'bought it');
  reset role;
end $$;

-- --- who may run it --------------------------------------------------------

do $$
declare refused boolean;
begin
  raise notice 'B9 — erasure is an admin capability, with a reason';

  refused := false;
  call auth.login_as('a0000000-0000-4000-8000-000000000001');
  begin
    perform public.admin_anonymise_user('a0000000-0000-4000-8000-000000000001', 'self');
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  perform public.assert(refused, 'a student cannot erase an account — not even their own, through this door');

  refused := false;
  call auth.login_as('a0000000-0000-4000-8000-000000000002');
  begin
    perform public.admin_anonymise_user('a0000000-0000-4000-8000-000000000001', 'meddling');
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  perform public.assert(refused, 'nor an instructor');

  refused := false;
  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  begin
    perform public.admin_anonymise_user('a0000000-0000-4000-8000-000000000001', '  ');
  exception when check_violation then refused := true;
  end;
  reset role;
  perform public.assert(refused, 'an admin must give a reason');
end $$;

-- --- staff are protected ---------------------------------------------------

do $$
declare refused boolean := false;
begin
  raise notice 'B9 — a colleague''s identity is not erasable through this path';

  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  begin
    perform public.admin_anonymise_user('a0000000-0000-4000-8000-000000000002', 'wrong target');
  exception when check_violation then refused := true;
  end;
  reset role;
  perform public.assert(refused, 'a staff account cannot be anonymised');
end $$;

-- --- the erasure itself ----------------------------------------------------

do $$
declare stamp timestamptz;
begin
  raise notice 'B9 — the person is scrubbed, the sale is kept';

  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  perform public.assert(
    public.admin_anonymise_user('a0000000-0000-4000-8000-000000000001', 'GDPR request 2026-09'),
    'an admin can erase a student who asked to be forgotten');
  reset role;

  perform public.assert(
    (select full_name from public.profiles where id = 'a0000000-0000-4000-8000-000000000001') = '',
    'the name is gone');
  perform public.assert(
    (select phone from public.profiles where id = 'a0000000-0000-4000-8000-000000000001') is null,
    'the phone is gone');
  -- Every identifying column, checked together. A column added to `profiles`
  -- without touching `admin_anonymise_user` survives an erasure, which is the
  -- one failure here that is both silent and serious — so the eraser's list is
  -- asserted, not trusted.
  perform public.assert(
    (select civility is null
        and first_name = ''
        and last_name = ''
        and phone_landline is null
        and birth_date is null
        and address = ''
        and postal_code = ''
        and city = ''
        and department = ''
        and avatar_key is null
     from public.profiles where id = 'a0000000-0000-4000-8000-000000000001'),
    'every enrolment field is scrubbed, not only the name and phone');
  select anonymised_at into stamp from public.profiles
   where id = 'a0000000-0000-4000-8000-000000000001';
  perform public.assert(stamp is not null, 'the account is stamped as erased');

  perform public.assert(
    not public.has_course_access('c0000000-0000-4000-8000-000000000001',
                                 'a0000000-0000-4000-8000-000000000001'),
    'access ends immediately');
  perform public.assert(
    (select status from public.entitlements
      where user_id = 'a0000000-0000-4000-8000-000000000001' and scope = 'course') = 'cancelled',
    'the entitlement is cancelled, not deleted — the history stands');

  perform public.assert(
    exists (select 1 from public.orders where id = '33330000-0000-4000-8000-000000000001'),
    'the order survives — the sale is the school''s record');
  perform public.assert(
    (select user_id from public.orders where id = '33330000-0000-4000-8000-000000000001')
      = 'a0000000-0000-4000-8000-000000000001',
    'still linked to the now-anonymised user, so the books reconcile');

  perform public.assert(
    (select actor_id from public.admin_audit where action = 'user.anonymise'
      order by created_at desc limit 1) = 'a0000000-0000-4000-8000-000000000003',
    'the trail names the admin who ran the erasure');
  perform public.assert(
    (select reason from public.admin_audit where action = 'user.anonymise'
      order by created_at desc limit 1) = 'GDPR request 2026-09',
    'and records the reason');
end $$;

-- --- idempotent ------------------------------------------------------------

do $$
declare first_stamp timestamptz; second_stamp timestamptz;
begin
  raise notice 'B9 — running it twice is safe';

  select anonymised_at into first_stamp from public.profiles
   where id = 'a0000000-0000-4000-8000-000000000001';

  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  perform public.assert(
    public.admin_anonymise_user('a0000000-0000-4000-8000-000000000001', 'retry'),
    'a second erasure still reports done');
  reset role;

  select anonymised_at into second_stamp from public.profiles
   where id = 'a0000000-0000-4000-8000-000000000001';
  perform public.assert(first_stamp = second_stamp,
    'and does not rewrite the date the account was first erased');
end $$;

drop function public.assert(boolean, text);

\echo ''
\echo 'ALL GDPR TESTS PASSED'
\echo ''
