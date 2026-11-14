-- ---------------------------------------------------------------------------
-- The rate limiter holds, and holds across callers (audit B8).
--
-- The limiter these assertions replace lived in one serverless instance's
-- memory, so the count reset on every cold start and an attacker spread across
-- warm instances was barely slowed. These prove the counter is now a single
-- atomic row: the increment and the limit test are one statement, distinct
-- buckets do not bleed into each other, the table is unreachable except through
-- the function, and rolled-over windows are pruned rather than left to grow.
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

\echo ''
\echo '=== rate limiting ==='

-- --- the cap is real ------------------------------------------------------

do $$
declare r jsonb;
begin
  raise notice 'B8 — a bucket is blocked once it passes its limit';

  -- Three hits allowed, the fourth refused. A wide window so the slot cannot
  -- roll over mid-test and reset the count under us.
  perform public.assert((public.rate_limit_hit('office-code:1.2.3.4', 3, 3600) ->> 'allowed')::boolean,
    'the first hit is allowed');
  perform public.assert((public.rate_limit_hit('office-code:1.2.3.4', 3, 3600) ->> 'allowed')::boolean,
    'the second hit is allowed');

  r := public.rate_limit_hit('office-code:1.2.3.4', 3, 3600);
  perform public.assert((r ->> 'allowed')::boolean, 'the third hit — exactly at the cap — is allowed');
  perform public.assert((r ->> 'remaining')::int = 0, 'and it reports nothing remaining');

  r := public.rate_limit_hit('office-code:1.2.3.4', 3, 3600);
  perform public.assert(not (r ->> 'allowed')::boolean, 'the fourth hit is refused');
  perform public.assert((r ->> 'retry_after')::int > 0, 'with a positive retry_after the caller can wait out');
end $$;

-- --- buckets are independent ----------------------------------------------

do $$
begin
  raise notice 'B8 — one caller''s spent budget is not another''s';

  -- The bucket above is over its limit; a different address starts fresh.
  perform public.assert((public.rate_limit_hit('office-code:9.9.9.9', 3, 3600) ->> 'allowed')::boolean,
    'a different address is not tarred with the first one''s count');

  -- Same address, different scope, is also its own budget.
  perform public.assert((public.rate_limit_hit('login:1.2.3.4', 3, 3600) ->> 'allowed')::boolean,
    'the same address on a different endpoint keeps a separate count');
end $$;

-- --- the count survives across calls (this is the whole point of B8) -------

do $$
declare slot bigint := floor(extract(epoch from now()) / 3600);
begin
  raise notice 'B8 — the counter is a durable row, not per-instance memory';

  perform public.assert(
    (select count from public.rate_limit_counters where id = 'office-code:1.2.3.4:' || slot::text) = 4,
    'every hit landed on the one shared row — four calls, count of four');
end $$;

-- --- the table is closed to clients ---------------------------------------

do $$
declare c bigint;
begin
  raise notice 'B8 — no client may read or write the counters directly';

  perform public.assert(
    not has_table_privilege('anon', 'public.rate_limit_counters', 'SELECT'),
    'anon cannot read the counters');
  perform public.assert(
    not has_table_privilege('authenticated', 'public.rate_limit_counters', 'SELECT'),
    'a signed-in user cannot read them either');
  perform public.assert(
    not has_table_privilege('authenticated', 'public.rate_limit_counters', 'UPDATE'),
    'nor tamper with a count to buy themselves more attempts');

  -- The function is the only door, and only the server holds the key. It
  -- takes the bucket, the limit and the window from its caller, so while it
  -- was open to `anon` anyone with the public key could fill another person's
  -- login bucket; the limiter now calls it as the service role.
  perform public.assert(
    not has_function_privilege('anon', 'public.rate_limit_hit(text, integer, integer)', 'EXECUTE'),
    'a visitor cannot call the limiter directly and name somebody else''s bucket');
  perform public.assert(
    not has_function_privilege('authenticated', 'public.rate_limit_hit(text, integer, integer)', 'EXECUTE'),
    'nor can a signed-in student');
  perform public.assert(
    has_function_privilege('service_role', 'public.rate_limit_hit(text, integer, integer)', 'EXECUTE'),
    'the server still can — the login form is limited through it, before sign-in');

  select count(*) into c from public.rate_limit_counters;
  perform public.assert(c >= 3, 'the definer function did the writes the caller could not');
end $$;

-- --- pruning clears rolled-over windows ------------------------------------

do $$
declare pruned integer;
begin
  raise notice 'B8 — pruning drops expired windows and keeps live ones';

  insert into public.rate_limit_counters (id, count, expires_at)
  values ('stale:window', 7, now() - interval '1 minute');

  pruned := public.prune_rate_limits();
  perform public.assert(pruned >= 1, 'at least the expired row was pruned');
  perform public.assert(
    not exists (select 1 from public.rate_limit_counters where id = 'stale:window'),
    'the expired window is gone');
  perform public.assert(
    exists (select 1 from public.rate_limit_counters where id like 'office-code:1.2.3.4:%'),
    'a window that has not rolled over is left alone');
end $$;

drop function public.assert(boolean, text);

\echo ''
\echo 'ALL RATE LIMIT TESTS PASSED'
\echo ''
