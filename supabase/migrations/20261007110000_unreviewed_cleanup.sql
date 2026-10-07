-- ---------------------------------------------------------------------------
-- Spam that confirms its e-mail, cleaned up without anyone deleting it
--
-- `unconfirmed_users` (20260917110000) removes signups that never confirmed.
-- The spam arriving since October 2026 does confirm — it owns real Gmail and
-- Hotmail inboxes and clicks the link within seconds — so it is never on that
-- list, and the office was deleting it by hand every day.
--
-- Its name cannot be relied on: a word list catches today's betting brand and
-- misses tomorrow's. What spam never does is the thing a student must do: the
-- office presses « Confirmer » on every real registration (it sets
-- `reviewed_at`, and a student cannot order before it), and a real student
-- pays. So the list is:
--
--   * a student account,
--   * the office never pressed « Confirmer »  (`reviewed_at is null`),
--   * no order,
--   * no entitlement — a student the office granted by hand is never touched,
--   * older than `older_than` (the sweep passes three days).
--
-- Deleting goes through the auth admin API in the sweep, the only thing that
-- can remove a user. Capped at 200 per run, like the unconfirmed list.
-- ---------------------------------------------------------------------------

create or replace function public.unreviewed_unpaid_users(older_than interval)
returns table (id uuid, email text, created_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.email::text, u.created_at
  from auth.users u
  join public.profiles p on p.id = u.id
  where p.role = 'student'
    and p.reviewed_at is null
    and u.created_at < now() - older_than
    and not exists (select 1 from public.orders o where o.user_id = u.id)
    and not exists (select 1 from public.entitlements e where e.user_id = u.id)
  order by u.created_at asc
  limit 200;
$$;

-- Supabase's default privileges grant EXECUTE on every new function in
-- `public` to anon and authenticated directly, so revoking from PUBLIC alone
-- leaves both able to call it — and this returns e-mail addresses. Named
-- explicitly. The test harness has no such default, which is how the same gap
-- in `unconfirmed_users` passed its own test; it is closed here too.
revoke all on function public.unreviewed_unpaid_users(interval) from public, anon, authenticated;
grant execute on function public.unreviewed_unpaid_users(interval) to service_role;

revoke all on function public.unconfirmed_users(interval) from public, anon, authenticated;
grant execute on function public.unconfirmed_users(interval) to service_role;
