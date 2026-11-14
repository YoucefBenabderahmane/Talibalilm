-- ---------------------------------------------------------------------------
-- What an order holds, and what a refund takes back.
--
-- Every assertion here corresponds to a defect found in the pre-launch audit:
-- B1 (a coupon consumed by an order that never completes), B3 (pack limits
-- declared but never enforced) and B6 (refunds invisible). They are written so
-- that reverting any of those fixes fails a named test rather than quietly
-- restoring the leak.
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
  ('a0000000-0000-4000-8000-000000000001', 'buyer@test.fr', '{"full_name":"Acheteur"}'::jsonb);

insert into public.courses (id, slug, title, status, published_at) values
  ('c0000000-0000-4000-8000-000000000001', 'fiqh', 'Fiqh', 'published', now());

insert into public.products (id, kind, course_id, delivery, time_slot, price_cents, status)
values ('11110000-0000-4000-8000-000000000001', 'module',
        'c0000000-0000-4000-8000-000000000001', 'online', 'semaine-soir', 30000, 'published');

-- A pack with exactly one redemption left, and a single-use coupon.
insert into public.packs (id, slug, title, delivery, pricing, status, max_redemptions, redeemed_count)
values ('22220000-0000-4000-8000-000000000001', 'derniere-place', 'Dernière place',
        'online', 'sum', 'published', 1, 0);

insert into public.coupons (code, percent_off, max_redemptions, is_office, batch)
values ('CAISSE-9001', 100, 1, true, 'test');

\echo ''
\echo '=== order holds and revocation ==='

-- --- B3: the pack limit is real -------------------------------------------

do $$
begin
  raise notice 'B3 — a pack redemption is scarce';

  perform public.assert(public.claim_pack('22220000-0000-4000-8000-000000000001'),
    'the last redemption of a limited pack can be claimed');

  perform public.assert(not public.claim_pack('22220000-0000-4000-8000-000000000001'),
    'and the next checkout is refused it — the limit is in the WHERE clause, not in TypeScript');

  perform public.assert(
    (select redeemed_count from public.packs
      where id = '22220000-0000-4000-8000-000000000001') = 1,
    'the counter reflects exactly one claim, never two');

  perform public.assert(public.claim_pack(null),
    'a basket with no pack is not blocked by pack accounting');
end $$;

-- --- B1: an order that never completes gives everything back --------------

do $$
declare oid uuid := '33330000-0000-4000-8000-000000000001';
begin
  raise notice 'B1 — an abandoned order releases what it held';

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, discount_cents, total_cents,
     coupon_id, pack_id, status, created_at)
  values (oid, 'a0000000-0000-4000-8000-000000000001', 'paypal', 'online',
          30000, 30000, 0,
          (select id from public.coupons where code = 'CAISSE-9001'),
          '22220000-0000-4000-8000-000000000001',
          'pending', now() - interval '2 hours');
  insert into public.order_items
    (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
  values (oid, '11110000-0000-4000-8000-000000000001', 'module',
          'c0000000-0000-4000-8000-000000000001', 'online', 30000, 365);

  perform public.redeem_coupon('CAISSE-9001');
  perform public.assert(public.redeem_coupon('CAISSE-9001') is null,
    'the code is spent while the order is open');

  perform public.assert(public.release_order_holds(oid), 'releasing returns both holds');

  perform public.assert(public.redeem_coupon('CAISSE-9001') is not null,
    'the coupon works again once the order is let go');
  perform public.assert(
    (select redeemed_count from public.packs
      where id = '22220000-0000-4000-8000-000000000001') = 0,
    'and so does the pack redemption');
end $$;

do $$
declare oid uuid := '33330000-0000-4000-8000-000000000001';
begin
  raise notice 'B1 — releasing twice cannot invent redemptions';

  perform public.assert(not public.release_order_holds(oid),
    'a second release reports nothing to do');
  perform public.assert(
    (select redeemed_count from public.packs
      where id = '22220000-0000-4000-8000-000000000001') = 0,
    'the pack counter has not gone negative or double-counted');
  perform public.assert(
    (select coupon_released_at is not null from public.orders where id = oid),
    'the stamp is what makes that safe, not the sweep running exactly once');
end $$;

do $$
declare swept integer;
begin
  raise notice 'B1 — the sweep cancels what the student walked away from';

  update public.orders set status = 'pending' where id = '33330000-0000-4000-8000-000000000001';

  swept := public.expire_pending_orders(interval '30 minutes');
  perform public.assert(swept >= 1, 'an order older than the window is swept');
  perform public.assert(
    (select status from public.orders where id = '33330000-0000-4000-8000-000000000001') = 'cancelled',
    'and ends up cancelled rather than pending forever');
  perform public.assert(
    (select status_reason from public.orders
      where id = '33330000-0000-4000-8000-000000000001') <> '',
    'with a reason the office can read');
end $$;

do $$
declare oid uuid := '33330000-0000-4000-8000-000000000002'; swept integer;
begin
  raise notice 'B1 — a fresh checkout is not swept out from under the student';

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status)
  values (oid, 'a0000000-0000-4000-8000-000000000001', 'paypal', 'online', 30000, 30000, 'pending');

  swept := public.expire_pending_orders(interval '30 minutes');
  perform public.assert(
    (select status from public.orders where id = oid) = 'pending',
    'an order opened a moment ago is left alone');
end $$;

do $$
declare oid uuid := '33330000-0000-4000-8000-000000000003';
begin
  raise notice 'B1 — a PAID order never hands its coupon back';

  insert into public.coupons (code, percent_off, max_redemptions, is_office, batch)
  values ('CAISSE-9002', 100, 1, true, 'test');
  perform public.redeem_coupon('CAISSE-9002');

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, discount_cents, total_cents,
     coupon_id, status, paid_at)
  values (oid, 'a0000000-0000-4000-8000-000000000001', 'office', 'online',
          30000, 30000, 0,
          (select id from public.coupons where code = 'CAISSE-9002'), 'paid', now());

  perform public.assert(not public.release_order_holds(oid),
    'releasing a paid order does nothing — the student still has what they bought');
  perform public.assert(public.redeem_coupon('CAISSE-9002') is null,
    'so the code stays spent, rather than being handed to someone else');
end $$;

-- --- B6: a refund takes access back ---------------------------------------

do $$
declare oid uuid := '33330000-0000-4000-8000-000000000004'; granted integer;
begin
  raise notice 'B6 — a refund removes the access it paid for';

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status, paid_at)
  values (oid, 'a0000000-0000-4000-8000-000000000001', 'paypal', 'online',
          30000, 30000, 'paid', now());
  insert into public.order_items
    (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
  values (oid, '11110000-0000-4000-8000-000000000001', 'module',
          'c0000000-0000-4000-8000-000000000001', 'online', 30000, 365);

  granted := public.grant_order_entitlements(oid);
  perform public.assert(granted = 1, 'the paid order granted access');
  perform public.assert(
    public.has_course_access('c0000000-0000-4000-8000-000000000001',
                             'a0000000-0000-4000-8000-000000000001'),
    'and the student can read the course');

  perform public.revoke_order_entitlements(oid, 'refunded by PayPal');

  perform public.assert(
    not public.has_course_access('c0000000-0000-4000-8000-000000000001',
                                 'a0000000-0000-4000-8000-000000000001'),
    'after the refund the student can no longer read it — this was impossible before');
  perform public.assert(
    (select status from public.orders where id = oid) = 'refunded',
    'the order records the refund');
  perform public.assert(
    (select status_reason from public.orders where id = oid) = 'refunded by PayPal',
    'with the reason PayPal gave');
end $$;

do $$
declare first_order uuid := '33330000-0000-4000-8000-000000000005';
        second_order uuid := '33330000-0000-4000-8000-000000000006';
        oid uuid;
begin
  raise notice 'B6 — refunding ONE of two purchases leaves the other standing';

  -- The case a naive "delete the entitlement" would get wrong: the student
  -- renewed, so two orders paid for the same course and only one came back.
  for oid in select unnest(array[first_order, second_order]) loop
    insert into public.orders
      (id, user_id, route, delivery, subtotal_cents, total_cents, status, paid_at)
    values (oid, 'a0000000-0000-4000-8000-000000000001', 'paypal', 'online',
            30000, 30000, 'paid', now());
    insert into public.order_items
      (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
    values (oid, '11110000-0000-4000-8000-000000000001', 'module',
            'c0000000-0000-4000-8000-000000000001', 'online', 30000, 365);
    perform public.grant_order_entitlements(oid);
  end loop;

  perform public.revoke_order_entitlements(second_order, 'refunded');

  perform public.assert(
    public.has_course_access('c0000000-0000-4000-8000-000000000001',
                             'a0000000-0000-4000-8000-000000000001'),
    'the year they did NOT get refunded is still theirs');
end $$;

drop function public.assert(boolean, text);

\echo ''
\echo 'ALL ORDER HOLD TESTS PASSED'
\echo ''
