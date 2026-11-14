-- ---------------------------------------------------------------------------
-- Who may call which SQL function.
--
-- The migrations lock server-only functions with `revoke … from public`. On
-- Supabase the default privileges grant EXECUTE to anon and authenticated
-- directly, which that revoke leaves in place — so until the function-grants
-- migration, a student could call `release_coupon`, `redeem_coupon`,
-- `expire_pending_orders` and the rest. The harness now replicates those
-- defaults (00_local_harness.sql), and this file is what keeps the door shut:
-- a new server-only function that forgets its revoke fails here, in CI,
-- rather than in production.
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
\echo '=== function grants ==='

do $$
begin
  raise notice 'S1 — the harness is as permissive as Supabase';

  -- Created in the harness before any migration, with no revoke: on Supabase
  -- such a function is callable by every API role. If this fails, the harness
  -- lost its default privileges and every assertion below is meaningless.
  perform public.assert(has_function_privilege('authenticated', 'public.harness_probe()', 'execute'),
    'a function created without an explicit revoke is executable by authenticated, as on Supabase');
  perform public.assert(has_function_privilege('anon', 'public.harness_probe()', 'execute'),
    'and by anon');
end $$;

do $$
declare
  closed text[] := array[
    'public.claim_confirmation_email(uuid)',
    'public.claim_due_installment_notices()',
    'public.claim_pack(uuid)',
    'public.end_stale_live_sessions(integer)',
    'public.expire_entitlements()',
    'public.expire_pending_orders(interval)',
    'public.grant_order_entitlements(uuid)',
    'public.prune_rate_limits()',
    'public.redeem_coupon(text)',
    'public.release_coupon(uuid)',
    'public.release_order_holds(uuid)',
    'public.revoke_order_entitlements(uuid, text)',
    'public.unconfirmed_users(interval)',
    'public.rate_limit_hit(text, integer, integer)'
  ];
  sig text;
begin
  raise notice 'S1 — the server''s functions are the server''s alone';

  foreach sig in array closed loop
    perform public.assert(not has_function_privilege('anon', sig, 'execute'),
      sig || ' is closed to anon');
    perform public.assert(not has_function_privilege('authenticated', sig, 'execute'),
      sig || ' is closed to authenticated — a student cannot call it with their own JWT');
    perform public.assert(has_function_privilege('service_role', sig, 'execute'),
      sig || ' stays open to the service role the sweep and the settlement use');
  end loop;
end $$;

do $$
begin
  raise notice 'S1 — what the app calls as the signed-in person stays open';

  perform public.assert(has_function_privilege('authenticated', 'public.has_course_access(uuid, uuid)', 'execute'),
    'has_course_access: the dashboard asks it with the student''s JWT');
  perform public.assert(has_function_privilege('authenticated', 'public.live_room_state(uuid)', 'execute'),
    'live_room_state: the classroom asks it on every token');
  perform public.assert(has_function_privilege('authenticated', 'public.can_join_live(uuid, uuid)', 'execute'),
    'can_join_live: policies evaluate it as the caller');
  perform public.assert(has_function_privilege('authenticated', 'public.is_admin(uuid)', 'execute'),
    'is_admin: the admin RPCs gate on it as the caller');
  perform public.assert(has_function_privilege('authenticated', 'public.admin_void_coupon(uuid, text)', 'execute'),
    'admin_void_coupon: an admin RPC is called with the admin''s own JWT so the audit names them');
  perform public.assert(has_function_privilege('anon', 'public.course_is_public(uuid)', 'execute'),
    'course_is_public: the catalogue policies evaluate it for visitors');
end $$;

do $$
begin
  raise notice 'S1 — a function created after the migration starts closed';

  execute 'create function public.__after_probe() returns integer language sql immutable as $f$ select 1 $f$';
  perform public.assert(not has_function_privilege('authenticated', 'public.__after_probe()', 'execute'),
    'authenticated cannot call a new function until a grant says so');
  perform public.assert(not has_function_privilege('anon', 'public.__after_probe()', 'execute'),
    'nor can anon');
  execute 'drop function public.__after_probe()';
end $$;
