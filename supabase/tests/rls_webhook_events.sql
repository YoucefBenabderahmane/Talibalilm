-- ---------------------------------------------------------------------------
-- A refund is applied once, and the webhook ledger is the server's.
--
-- `revoke_order_entitlements` used to subtract the order's days on every call
-- and never asked whether the order had been paid. PayPal redelivers events
-- and sends several for one refund, so one refund could take back years the
-- student had bought in other orders. These assertions pin the fix.
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

\echo ''
\echo '=== refund idempotency and the webhook ledger ==='

do $$
declare
  oid uuid := '44440000-0000-4000-8000-000000000001';
  touched integer;
  granted_until timestamptz;
  after_first timestamptz;
  after_second timestamptz;
begin
  raise notice 'S2 — a refund is applied once, however many times PayPal says it';

  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status, paid_at)
  values (oid, 'a0000000-0000-4000-8000-000000000001', 'paypal', 'online',
          30000, 30000, 'paid', now());
  insert into public.order_items
    (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
  values (oid, '11110000-0000-4000-8000-000000000001', 'module',
          'c0000000-0000-4000-8000-000000000001', 'online', 30000, 365);

  perform public.assert(public.grant_order_entitlements(oid) = 1, 'the paid order granted a year');
  select expires_at into granted_until from public.entitlements
   where user_id = 'a0000000-0000-4000-8000-000000000001'
     and course_id = 'c0000000-0000-4000-8000-000000000001';

  touched := public.revoke_order_entitlements(oid, 'refunded through PayPal');
  perform public.assert(touched = 1, 'the first refund touches the entitlement');
  select expires_at into after_first from public.entitlements
   where user_id = 'a0000000-0000-4000-8000-000000000001'
     and course_id = 'c0000000-0000-4000-8000-000000000001';
  perform public.assert(after_first = granted_until - interval '365 days',
    'and takes back exactly the days the order bought');
  perform public.assert(
    (select status from public.orders where id = oid) = 'refunded',
    'the order is now refunded');

  -- PayPal delivers it again (or sends the dispute that follows the refund).
  touched := public.revoke_order_entitlements(oid, 'refunded through PayPal');
  perform public.assert(touched = 0, 'a redelivered refund touches nothing');
  select expires_at into after_second from public.entitlements
   where user_id = 'a0000000-0000-4000-8000-000000000001'
     and course_id = 'c0000000-0000-4000-8000-000000000001';
  perform public.assert(after_second = after_first,
    'the expiry stays where the first refund left it — before, every redelivery took another year');
end $$;

do $$
declare
  paid_oid uuid := '44440000-0000-4000-8000-000000000002';
  pending_oid uuid := '44440000-0000-4000-8000-000000000003';
  held_until timestamptz;
  touched integer;
begin
  raise notice 'S2 — a denied capture on an order that never paid takes nothing back';

  -- The student holds a year from a different, paid order.
  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status, paid_at)
  values (paid_oid, 'a0000000-0000-4000-8000-000000000001', 'paypal', 'online',
          30000, 30000, 'paid', now());
  insert into public.order_items
    (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
  values (paid_oid, '11110000-0000-4000-8000-000000000001', 'module',
          'c0000000-0000-4000-8000-000000000001', 'online', 30000, 365);
  perform public.grant_order_entitlements(paid_oid);
  select max(expires_at) into held_until from public.entitlements
   where user_id = 'a0000000-0000-4000-8000-000000000001';
  perform public.assert(held_until > now() + interval '300 days', 'the student has their year');

  -- A second checkout for the same module that PayPal denied: never paid.
  insert into public.orders
    (id, user_id, route, delivery, subtotal_cents, total_cents, status)
  values (pending_oid, 'a0000000-0000-4000-8000-000000000001', 'paypal', 'online',
          30000, 30000, 'pending');
  insert into public.order_items
    (order_id, product_id, kind, course_id, delivery, unit_price_cents, duration_days)
  values (pending_oid, '11110000-0000-4000-8000-000000000001', 'module',
          'c0000000-0000-4000-8000-000000000001', 'online', 30000, 365);

  touched := public.revoke_order_entitlements(pending_oid, 'capture denied');
  perform public.assert(touched = 0, 'revoking an order that never paid touches nothing');
  perform public.assert(
    (select max(expires_at) from public.entitlements
      where user_id = 'a0000000-0000-4000-8000-000000000001') = held_until,
    'the year from the paid order is untouched — before, the denied order took it');
  perform public.assert(
    (select status from public.orders where id = pending_oid) = 'pending',
    'and the pending order is not relabelled refunded');
end $$;

do $$
begin
  raise notice 'S2 — the webhook ledger belongs to the service role';

  perform public.assert(
    (select relrowsecurity from pg_class where oid = 'public.paypal_webhook_events'::regclass),
    'row-level security is on');
  perform public.assert(not has_table_privilege('anon', 'public.paypal_webhook_events', 'select'),
    'anon cannot read it');
  perform public.assert(not has_table_privilege('authenticated', 'public.paypal_webhook_events', 'select'),
    'a signed-in student cannot read it');
  perform public.assert(not has_table_privilege('authenticated', 'public.paypal_webhook_events', 'insert'),
    'nor write to it');
  perform public.assert(has_table_privilege('service_role', 'public.paypal_webhook_events', 'insert'),
    'the service role records events');

  insert into public.paypal_webhook_events (event_id, event_type, order_id)
  values ('WH-1', 'PAYMENT.CAPTURE.REFUNDED', '44440000-0000-4000-8000-000000000001');
  begin
    insert into public.paypal_webhook_events (event_id, event_type, order_id)
    values ('WH-1', 'PAYMENT.CAPTURE.REFUNDED', '44440000-0000-4000-8000-000000000001');
    perform public.assert(false, 'a second record of the same event id must be refused');
  exception when unique_violation then
    perform public.assert(true, 'the same event id cannot be recorded twice — the route reads that as a replay');
  end;
end $$;
