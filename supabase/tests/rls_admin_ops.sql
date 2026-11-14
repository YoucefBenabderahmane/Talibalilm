-- ---------------------------------------------------------------------------
-- The office operations, and who is allowed to run them.
--
-- These back the Orders / Students / Coupons screens the audit called B7. The
-- point of every assertion is the same: a privileged action is gated on
-- is_admin() INSIDE a security-definer function, records the real actor, and
-- refuses a student even though the function bypasses RLS to do its work.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Put pgcrypto where SUPABASE puts it, before anything runs.
--
-- Supabase ships pgcrypto pre-installed in the `extensions` schema, so the
-- `create extension if not exists "pgcrypto"` in 20260910120000 is a no-op
-- there and the extension never lands in `public`. Every SECURITY DEFINER
-- function here is pinned to `search_path = public, pg_temp` — correctly, so a
-- caller cannot shadow a table — which also means none of them can see a
-- single pgcrypto function.
--
-- The coupon generator called `gen_random_bytes` and therefore could never
-- have worked on a real project, while passing every test on a local database
-- where pgcrypto happened to be in `public`. The test was reproducing the
-- wrong world. This makes it reproduce the right one.
-- ---------------------------------------------------------------------------
drop extension if exists pgcrypto cascade;
create schema if not exists extensions;
create extension pgcrypto with schema extensions;

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
  ('a0000000-0000-4000-8000-000000000001', 'student@test.fr', '{"full_name":"Étudiant"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000002', 'staff@test.fr',   '{"full_name":"Prof"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000003', 'admin@test.fr',   '{"full_name":"Direction"}'::jsonb);
update public.profiles set role = 'instructor' where id = 'a0000000-0000-4000-8000-000000000002';
update public.profiles set role = 'admin' where id = 'a0000000-0000-4000-8000-000000000003';

insert into public.courses (id, slug, title, status, published_at) values
  ('c0000000-0000-4000-8000-000000000001', 'fiqh', 'Fiqh', 'published', now());

\echo ''
\echo '=== admin operations ==='

-- --- emails: staff yes, student no ----------------------------------------

do $$
declare refused boolean := false;
begin
  raise notice 'reading emails is a staff capability';

  call auth.login_as('a0000000-0000-4000-8000-000000000002');
  perform public.assert(
    (select email from public.emails_for(array['a0000000-0000-4000-8000-000000000001'::uuid]))
      = 'student@test.fr',
    'a staff member can resolve a user id to an email for the office screens');
  reset role;

  call auth.login_as('a0000000-0000-4000-8000-000000000001');
  begin
    perform public.emails_for(array['a0000000-0000-4000-8000-000000000002'::uuid]);
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'a student cannot read anyone''s email');
  reset role;
end $$;

-- --- manual grant: admin only, reason required, audited --------------------

do $$
declare ent uuid; refused boolean := false;
begin
  raise notice 'granting access by hand';

  call auth.login_as('a0000000-0000-4000-8000-000000000002');
  begin
    perform public.admin_grant_entitlement(
      'a0000000-0000-4000-8000-000000000001', 'course',
      'c0000000-0000-4000-8000-000000000001', null, 1, 'online', 365, 'test');
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'an INSTRUCTOR cannot grant access — this is admin only');
  reset role;

  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  refused := false;
  begin
    perform public.admin_grant_entitlement(
      'a0000000-0000-4000-8000-000000000001', 'course',
      'c0000000-0000-4000-8000-000000000001', null, 1, 'online', 365, '');
  exception when check_violation then refused := true;
  end;
  perform public.assert(refused, 'a grant with no reason is refused');

  ent := public.admin_grant_entitlement(
    'a0000000-0000-4000-8000-000000000001', 'course',
    'c0000000-0000-4000-8000-000000000001', null, 1, 'online', 365, 'scholarship 2026');
  perform public.assert(ent is not null, 'an admin can grant with a reason');
  perform public.assert(
    public.has_course_access('c0000000-0000-4000-8000-000000000001',
                             'a0000000-0000-4000-8000-000000000001'),
    'and the student can now read the course');
  perform public.assert(
    (select actor_id from public.admin_audit
      where action = 'entitlement.grant' order by created_at desc limit 1)
      = 'a0000000-0000-4000-8000-000000000003',
    'the trail names the admin who did it, not the service role');
  perform public.assert(
    (select reason from public.admin_audit
      where action = 'entitlement.grant' order by created_at desc limit 1) = 'scholarship 2026',
    'and records the reason they gave');
  reset role;
end $$;

do $$
declare ent uuid; before_expiry timestamptz; after_expiry timestamptz;
begin
  raise notice 'a second manual grant stacks rather than duplicating';

  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  select expires_at into before_expiry from public.entitlements
   where user_id = 'a0000000-0000-4000-8000-000000000001' and scope = 'course';

  ent := public.admin_grant_entitlement(
    'a0000000-0000-4000-8000-000000000001', 'course',
    'c0000000-0000-4000-8000-000000000001', null, 1, 'online', 30, 'extra month');

  select expires_at into after_expiry from public.entitlements
   where user_id = 'a0000000-0000-4000-8000-000000000001' and scope = 'course';
  perform public.assert(after_expiry > before_expiry,
    'the existing entitlement is extended, not a second one created');
  perform public.assert(
    (select count(*) from public.entitlements
      where user_id = 'a0000000-0000-4000-8000-000000000001' and scope = 'course') = 1,
    'still one row for that course');
  reset role;
end $$;

-- --- manual revoke ---------------------------------------------------------

do $$
declare ent uuid;
begin
  raise notice 'revoking access by hand';
  call auth.login_as('a0000000-0000-4000-8000-000000000003');

  select id into ent from public.entitlements
   where user_id = 'a0000000-0000-4000-8000-000000000001' and scope = 'course';

  perform public.assert(public.admin_revoke_entitlement(ent, 'left the programme'),
    'an admin can revoke a live entitlement');
  perform public.assert(
    not public.has_course_access('c0000000-0000-4000-8000-000000000001',
                                 'a0000000-0000-4000-8000-000000000001'),
    'and the student loses access immediately');
  perform public.assert(
    (select action from public.admin_audit order by created_at desc limit 1) = 'entitlement.revoke',
    'the revoke is on the trail too');
  reset role;
end $$;

-- --- coupon generation -----------------------------------------------------

do $$
declare codes text[]; refused boolean := false;
begin
  raise notice 'generating cash codes';

  call auth.login_as('a0000000-0000-4000-8000-000000000001');
  begin
    perform public.admin_generate_coupons(5, 100, null, 1, true, 'sept', 'CAISSE', null);
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'a student cannot mint coupons');
  reset role;

  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  select array_agg(c) into codes
    from public.admin_generate_coupons(10, 100, null, 1, true, 'sept-2026', 'CAISSE', null) c;
  perform public.assert(array_length(codes, 1) = 10, 'ten codes generated');
  perform public.assert(
    (select count(distinct c) from unnest(codes) c) = 10, 'and all ten are distinct');
  perform public.assert(
    (select bool_and(c ~ '^[A-Z0-9-]{6,32}$') from unnest(codes) c),
    'each matches the coupon code shape the constraint enforces');
  perform public.assert(
    (select count(*) from public.coupons where batch = 'sept-2026') = 10,
    'and all ten are stored against the batch for reconciliation');
  reset role;
end $$;

-- --- the prefix is genuinely optional --------------------------------------
--
-- The first version built the code with `nullif(prefix, '') || ...`, so with
-- no prefix the whole concatenation was NULL, the `length(new_code) < 6` guard
-- evaluated to NULL instead of true, and a NULL code reached the INSERT. The
-- resulting not_null_violation is not a unique_violation, so it escaped the
-- retry handler and surfaced to the admin as a bare save failure.

do $$
declare codes text[];
begin
  raise notice 'generating codes with no prefix at all';
  call auth.login_as('a0000000-0000-4000-8000-000000000003');

  select array_agg(c) into codes
    from public.admin_generate_coupons(5, 20, null, 1, false, 'no-prefix', '', null) c;
  perform public.assert(array_length(codes, 1) = 5,
    'five codes generated with an empty prefix');
  perform public.assert(
    (select bool_and(c is not null and c ~ '^[A-Z0-9]{6,32}$') from unnest(codes) c),
    'each is a real code, not NULL, and carries no stray separator');

  -- NULL is what the client sends when the field is absent entirely.
  select array_agg(c) into codes
    from public.admin_generate_coupons(3, 20, null, 1, false, 'null-prefix', null, null) c;
  perform public.assert(array_length(codes, 1) = 3,
    'and a NULL prefix behaves the same as an empty one');

  -- A prefix still works, for the cash desk batches that rely on it.
  select array_agg(c) into codes
    from public.admin_generate_coupons(3, 20, null, 1, true, 'kept-prefix', 'CAISSE', null) c;
  perform public.assert(
    (select bool_and(c like 'CAISSE-%') from unnest(codes) c),
    'a prefix given is still honoured');
  reset role;
end $$;

-- --- voiding a coupon ------------------------------------------------------

do $$
declare cid uuid;
begin
  raise notice 'voiding a code that got out';
  call auth.login_as('a0000000-0000-4000-8000-000000000003');

  select id into cid from public.coupons where batch = 'sept-2026' limit 1;
  perform public.assert(public.admin_void_coupon(cid, 'leaked'),
    'an admin can void a code');
  reset role;

  -- The voided code can no longer be redeemed, through the same function the
  -- checkout uses.
  perform public.assert(
    public.redeem_coupon((select code from public.coupons where id = cid)) is null,
    'and it can never be spent again');
end $$;

-- --- the trail is readable by admins and by no one else --------------------

do $$
declare refused boolean := false;
begin
  raise notice 'the trail is admin-only';

  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  perform public.assert((select count(*) from public.admin_audit) >= 4,
    'an admin can read the trail');
  reset role;

  call auth.login_as('a0000000-0000-4000-8000-000000000002');
  perform public.assert((select count(*) from public.admin_audit) = 0,
    'an instructor cannot — a manual grant is above their pay grade to review');
  reset role;

  call auth.login_as('a0000000-0000-4000-8000-000000000001');
  begin
    insert into public.admin_audit (action) values ('forged');
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused,
    'and no client can write the trail directly — it cannot be forged by the person it holds accountable');
  reset role;
end $$;

-- --- email is sent at most once -------------------------------------------

do $$
declare oid uuid := '44440000-4000-4000-8000-000000000001';
begin
  raise notice 'the confirmation email claim is a lock';

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status, paid_at)
  values (oid, 'a0000000-0000-4000-8000-000000000001', 'paypal', 'online',
          10000, 10000, 'paid', now());

  perform public.assert(public.claim_confirmation_email(oid),
    'the first caller wins the right to send');
  perform public.assert(not public.claim_confirmation_email(oid),
    'and a webhook retry racing the return route is refused — sent at most once');
end $$;

-- --- who may buy: the approval gate ----------------------------------------

do $$
declare
  refused boolean := false;
  returned text;
  audit_count integer;
begin
  raise notice 'an account is let in deliberately';

  -- A fresh registration is pending. The migration approved everyone who
  -- existed before the gate came back, so this is set directly.
  update public.profiles set approved_at = null
   where id = 'a0000000-0000-4000-8000-000000000001';

  perform public.assert(
    not public.is_approved('a0000000-0000-4000-8000-000000000001'),
    'a pending student may not open an order');

  perform public.assert(
    public.is_approved('a0000000-0000-4000-8000-000000000002'),
    'staff are never pending — a promotion must not put somebody in a queue');

  -- A student cannot approve themselves, or anybody else.
  call auth.login_as('a0000000-0000-4000-8000-000000000001');
  begin
    perform public.admin_set_approval('a0000000-0000-4000-8000-000000000001', true);
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  perform public.assert(refused, 'and cannot approve themselves');

  -- The admin can.
  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  returned := public.admin_set_approval('a0000000-0000-4000-8000-000000000001', true);
  reset role;

  perform public.assert(returned = 'student@test.fr',
    'approving returns the address to write to, and only when something changed');
  perform public.assert(
    public.is_approved('a0000000-0000-4000-8000-000000000001'),
    'and the account may now buy');

  -- Idempotent: a second press is not an event, so nothing is returned and no
  -- second message can be sent.
  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  returned := public.admin_set_approval('a0000000-0000-4000-8000-000000000001', true);
  reset role;
  perform public.assert(returned is null,
    'approving an approved account is a no-op rather than a second welcome');

  select count(*) into audit_count from public.admin_audit
   where action = 'student.approve' and target_id = 'a0000000-0000-4000-8000-000000000001';
  perform public.assert(audit_count = 1,
    'and exactly one audit row names who let them in');

  -- Putting them back in the queue is the same decision, the other way.
  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  returned := public.admin_set_approval('a0000000-0000-4000-8000-000000000001', false);
  reset role;
  perform public.assert(
    returned = 'student@test.fr'
      and not public.is_approved('a0000000-0000-4000-8000-000000000001'),
    'an admin can put an account back in the queue');

  -- Staff are not a student account: the RPC refuses rather than quietly
  -- clearing a colleague's approval.
  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  begin
    perform public.admin_set_approval('a0000000-0000-4000-8000-000000000002', false);
  exception when check_violation then refused := true;
  end;
  reset role;
  perform public.assert(refused, 'and a staff account is not something to approve');

  -- The queue count is a staff answer, and zero for anyone else.
  call auth.login_as('a0000000-0000-4000-8000-000000000002');
  perform public.assert(public.pending_student_count() = 1,
    'the office sees exactly who is waiting');
  reset role;

  call auth.login_as('a0000000-0000-4000-8000-000000000001');
  perform public.assert(public.pending_student_count() = 0,
    'and a student asking gets nothing');
  reset role;

  -- Leave the fixture as the rest of the suite expects it.
  update public.profiles set approved_at = now()
   where id = 'a0000000-0000-4000-8000-000000000001';
end $$;

-- --- correcting a wrong choice ---------------------------------------------

do $$
declare
  refused boolean := false;
  granted_id uuid;
  old_id uuid;
begin
  raise notice 'a wrong module can be swapped, and the money is left alone';

  -- A second module to correct TO, and an order that opened the first.
  insert into public.courses (id, slug, title, status, published_at) values
    ('c0000000-0000-4000-8000-000000000002', 'aqida', 'Aqida', 'published', now());

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status, paid_at)
  values ('33330000-0000-4000-8000-000000000011',
          'a0000000-0000-4000-8000-000000000001', 'paypal', 'online',
          18000, 18000, 'paid', now());

  insert into public.entitlements
    (user_id, scope, course_id, delivery, expires_at, source_order_id, note)
  values ('a0000000-0000-4000-8000-000000000001', 'course',
          'c0000000-0000-4000-8000-000000000001', 'online',
          now() + interval '300 days', '33330000-0000-4000-8000-000000000011', 'achat')
  returning id into old_id;

  -- A student cannot correct anything.
  call auth.login_as('a0000000-0000-4000-8000-000000000001');
  begin
    perform public.admin_correct_order(
      '33330000-0000-4000-8000-000000000011', old_id,
      'c0000000-0000-4000-8000-000000000002', null, null, 'je préfère');
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  perform public.assert(refused, 'a student cannot correct their own order');

  -- The admin can.
  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  granted_id := public.admin_correct_order(
    '33330000-0000-4000-8000-000000000011', old_id,
    'c0000000-0000-4000-8000-000000000002', null, null, 'mauvais module choisi');
  reset role;

  perform public.assert(granted_id is not null, 'the replacement is granted');

  perform public.assert(
    (select status from public.entitlements where id = old_id) = 'cancelled',
    'and the wrong one is cancelled rather than deleted — history stands');

  perform public.assert(
    public.has_course_access('c0000000-0000-4000-8000-000000000002',
                             'a0000000-0000-4000-8000-000000000001'),
    'the student can now read the right module');
  perform public.assert(
    not public.has_course_access('c0000000-0000-4000-8000-000000000001',
                                 'a0000000-0000-4000-8000-000000000001'),
    'and no longer the wrong one');

  perform public.assert(
    (select expires_at from public.entitlements where id = granted_id)
      <= now() + interval '301 days',
    'the replacement keeps the REMAINING days, not a fresh term');

  perform public.assert(
    (select source_order_id from public.entitlements where id = granted_id)
      = '33330000-0000-4000-8000-000000000011',
    'and still points at the order that paid for it');

  perform public.assert(
    (select count(*) from public.order_corrections
      where order_id = '33330000-0000-4000-8000-000000000011') = 1,
    'the correction is recorded on the order');

  -- A reason is required, and an entitlement this order did not buy is refused.
  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  begin
    perform public.admin_correct_order(
      '33330000-0000-4000-8000-000000000011', granted_id,
      'c0000000-0000-4000-8000-000000000001', null, null, '   ');
  exception when check_violation then refused := true;
  end;
  reset role;
  perform public.assert(refused, 'a correction without a reason is refused');

  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  refused := false;
  begin
    perform public.admin_correct_order(
      '33330000-0000-4000-8000-000000000011', '11111111-1111-1111-1111-111111111111',
      'c0000000-0000-4000-8000-000000000001', null, null, 'pas la mienne');
  exception when check_violation then refused := true;
  end;
  reset role;
  perform public.assert(refused, 'and an entitlement from another order is refused');
end $$;

drop function public.assert(boolean, text);

\echo ''
\echo 'ALL ADMIN OPERATION TESTS PASSED'
\echo ''
