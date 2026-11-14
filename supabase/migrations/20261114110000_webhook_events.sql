-- ---------------------------------------------------------------------------
-- A refund is taken back once, and a webhook delivery is counted once.
--
-- `revoke_order_entitlements` subtracted the order's days from the student's
-- entitlement every time it was called, and it did not ask whether the order
-- had ever been paid. PayPal redelivers a webhook until it gets a 2xx, and
-- sends more than one event for one refund (REFUNDED, then a DISPUTE), so a
-- single refund could take back two or three years — including years the
-- student had bought in other orders, since renewals stack on one row. And a
-- PAYMENT.CAPTURE.DENIED on a pending order, which never granted anything,
-- still wound back whatever the student already held.
--
-- Two changes:
--
--   1. The function returns 0 unless the order is `paid`. Once it has run the
--      order is `refunded`, so running it again is a no-op by construction —
--      the status is the stamp, as `coupon_released_at` is for holds.
--   2. A ledger of webhook event ids. The route inserts the id before acting
--      and treats a unique violation as a replay. Service role only: nothing
--      in the browser has a reason to read it.
-- ---------------------------------------------------------------------------

create or replace function public.revoke_order_entitlements(oid uuid, reason text default '')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o public.orders%rowtype;
  item public.order_items%rowtype;
  touched integer := 0;
begin
  select * into o from public.orders where id = oid for update;
  if not found then
    raise exception 'order % does not exist', oid using errcode = 'no_data_found';
  end if;

  -- Only a paid order has given anything to take back. A pending, failed or
  -- cancelled one granted nothing; a refunded one has already been handled.
  -- Returning rather than raising: the webhook has nothing to retry.
  if o.status <> 'paid' then
    return 0;
  end if;

  -- `entitlements_period` insists a row cannot end before it begins, and it is
  -- a plain CHECK, so it is evaluated at the end of every statement. Winding
  -- the expiry back in one statement and repairing the start in the next
  -- therefore fails on the first — both have to move together. On the right of
  -- the assignment `expires_at` is still the old value, which is what makes
  -- that expressible.
  for item in select * from public.order_items where order_id = oid loop
    if item.kind = 'module' then
      update public.entitlements
         set expires_at = expires_at - make_interval(days => item.duration_days),
             starts_at  = least(
               starts_at,
               expires_at - make_interval(days => item.duration_days) - interval '1 second'
             )
       where user_id = o.user_id and scope = 'course'
         and course_id = item.course_id and delivery = item.delivery;
    else
      update public.entitlements
         set expires_at = expires_at - make_interval(days => item.duration_days),
             starts_at  = least(
               starts_at,
               expires_at - make_interval(days => item.duration_days) - interval '1 second'
             )
       where user_id = o.user_id and scope = 'cursus'
         and cursus_id = item.cursus_id and year_index = item.year_index
         and delivery = item.delivery;
    end if;
    touched := touched + 1;
  end loop;

  -- Anything wound back to or past now is spent. `has_course_access` already
  -- ignores it on the clock; this only keeps the listings honest.
  update public.entitlements
     set status = 'cancelled'
   where user_id = o.user_id and status = 'active' and expires_at <= now();

  update public.orders
     set status = 'refunded',
         status_reason = case when reason = '' then 'refunded' else reason end
   where id = oid;

  return touched;
end;
$$;

revoke all on function public.revoke_order_entitlements(uuid, text) from public, anon, authenticated;
grant execute on function public.revoke_order_entitlements(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- The webhook ledger.
-- ---------------------------------------------------------------------------

create table public.paypal_webhook_events (
  event_id    text primary key,
  event_type  text not null,
  order_id    uuid,
  received_at timestamptz not null default now()
);

comment on table public.paypal_webhook_events is
  'One row per PayPal webhook event id the site has acted on. A second insert of the same id is a replay.';

alter table public.paypal_webhook_events enable row level security;

-- No policies: nothing signed in reads or writes this. The service role
-- bypasses RLS and holds the only grant.
revoke all on public.paypal_webhook_events from public, anon, authenticated;
grant select, insert on public.paypal_webhook_events to service_role;
