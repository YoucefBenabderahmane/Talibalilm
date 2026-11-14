-- ---------------------------------------------------------------------------
-- Deleting coupon codes, and what it costs.
--
-- The office deletes used codes to clean the list, and the one thing that must
-- stay true is that a code is not a record of a sale: `orders.coupon_id` is
-- `on delete set null`, so the order keeps its amounts and loses only the link
-- to the code. Three claims:
--
--   * only an admin may delete, and only through the audited function;
--   * the audit names the real admin and the code, after the row is gone;
--   * the order that used the code survives.
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
  ('e0000000-0000-4000-8000-000000000001', 'student@test.fr', '{"full_name":"Étudiant"}'::jsonb),
  ('e0000000-0000-4000-8000-000000000002', 'staff@test.fr',   '{"full_name":"Prof"}'::jsonb),
  ('e0000000-0000-4000-8000-000000000003', 'admin@test.fr',   '{"full_name":"Direction"}'::jsonb);

update public.profiles set role = 'instructor' where id = 'e0000000-0000-4000-8000-000000000002';
update public.profiles set role = 'admin' where id = 'e0000000-0000-4000-8000-000000000003';

insert into public.coupons (id, code, percent_off, max_redemptions, redeemed_count, batch) values
  ('f0000000-0000-4000-8000-000000000001', 'PROMO-USED-2026', 20, 1, 1, 'septembre'),
  ('f0000000-0000-4000-8000-000000000002', 'PROMO-SPARE-2026', 20, 1, 0, 'septembre');

-- The order that used the first code: 10 € off 50 €.
insert into public.orders (id, user_id, route, delivery, subtotal_cents, discount_cents,
                           total_cents, coupon_id)
values ('f1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
        'paypal', 'online', 5000, 1000, 4000, 'f0000000-0000-4000-8000-000000000001');

\echo ''
\echo '=== deleting coupon codes ==='

do $$
declare
  refused boolean := false;
  removed integer;
begin
  raise notice 'only an admin may delete a code';

  call auth.login_as('e0000000-0000-4000-8000-000000000001');
  begin
    perform public.admin_delete_coupons(
      array['f0000000-0000-4000-8000-000000000001'::uuid]);
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'a student cannot delete a coupon');
  reset role;

  call auth.login_as('e0000000-0000-4000-8000-000000000002');
  refused := false;
  begin
    perform public.admin_delete_coupons(
      array['f0000000-0000-4000-8000-000000000001'::uuid]);
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'an instructor cannot delete a coupon — admin only');
  reset role;

  call auth.login_as('e0000000-0000-4000-8000-000000000003');
  removed := public.admin_delete_coupons(
    array['f0000000-0000-4000-8000-000000000001'::uuid]);
  perform public.assert(removed = 1, 'an admin deletes the used code, and the count says so');
  perform public.assert(
    not exists (select 1 from public.coupons
                 where id = 'f0000000-0000-4000-8000-000000000001'),
    'the code is gone');

  -- The order is the record of the sale; the code was only how it was paid.
  perform public.assert(
    (select count(*) from public.orders
      where id = 'f1000000-0000-4000-8000-000000000001') = 1,
    'the order survives the deletion');
  perform public.assert(
    (select total_cents from public.orders
      where id = 'f1000000-0000-4000-8000-000000000001') = 4000,
    'and still says what was actually charged');
  perform public.assert(
    (select coupon_id is null from public.orders
      where id = 'f1000000-0000-4000-8000-000000000001'),
    'while the link to the deleted code is nulled, not cascaded');

  -- The audit is written from the rows the DELETE returned, so it can name the
  -- code after the row itself is gone.
  perform public.assert(
    (select actor_id from public.admin_audit
      where action = 'coupon.delete' order by created_at desc limit 1)
      = 'e0000000-0000-4000-8000-000000000003',
    'the trail names the admin who deleted it');
  perform public.assert(
    (select detail ->> 'code' from public.admin_audit
      where action = 'coupon.delete' order by created_at desc limit 1) = 'PROMO-USED-2026',
    'and records which code it was');

  -- A spare code is untouched, and an empty selection is a no-op rather than
  -- an error: the list can legitimately hold nothing to delete.
  perform public.assert(
    public.admin_delete_coupons(array[]::uuid[]) = 0,
    'deleting nothing returns zero');
  perform public.assert(
    exists (select 1 from public.coupons
             where id = 'f0000000-0000-4000-8000-000000000002'),
    'a code that was not selected is left alone');
  reset role;
end $$;
