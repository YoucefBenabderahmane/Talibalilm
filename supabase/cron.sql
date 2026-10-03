-- ---------------------------------------------------------------------------
-- The database-only half of the sweep, on a timer inside Postgres.
--
-- The app's /api/cron/sweep still runs these jobs — and the ones that need
-- code: R2 video purge, installment reminders, spam purge — but every call is
-- a serverless function invocation that pays startup CPU, and the schedule can
-- only be as tight as the caller allows. Supabase's pg_cron runs this inside
-- the database: no function invocation, no egress, and the fifteen-minute
-- cadence the coupon release actually needs.
--
-- OPTIONAL. Enable pg_cron first (Supabase → Database → Extensions), then run
-- this file in the SQL editor. The app endpoint stays the fallback, and every
-- job below is idempotent, so running both is harmless.
--
-- Not part of supabase/migrations/ on purpose: the offline test harness runs
-- the migrations against a scratch Postgres that does not have pg_cron, and a
-- migration that cannot apply there would take the whole policy suite down.
-- Like storage.sql, this is a first-install script, applied by hand.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;

create or replace function public.sweep_housekeeping()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The two money-critical jobs: cancel abandoned checkouts (handing back the
  -- coupon and pack seat they hold), and stamp expired entitlements expired.
  perform public.expire_pending_orders(interval '30 minutes');
  perform public.expire_entitlements();
  -- Rooms nobody closed, and rate-limit windows that have rolled over.
  perform public.end_stale_live_sessions(5);
  perform public.prune_rate_limits();
end;
$$;

revoke all on function public.sweep_housekeeping() from public, anon, authenticated;

-- Re-runnable: unschedule by name first, so applying this file twice replaces
-- the job instead of stacking a second one.
do $$
begin
  perform cron.unschedule('sweep-housekeeping');
exception
  when others then null;
end;
$$;

select cron.schedule(
  'sweep-housekeeping',
  '*/15 * * * *',
  $$select public.sweep_housekeeping()$$
);
