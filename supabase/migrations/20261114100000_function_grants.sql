-- ---------------------------------------------------------------------------
-- Close the service-role-only functions to anon and authenticated.
--
-- Every function below was written for the server alone — the sweep, the
-- PayPal settlement, the coupon claim — and each was locked with
--
--   revoke all on function … from public;
--   grant execute on function … to service_role;
--
-- On Supabase that is not enough. The project's default privileges grant
-- EXECUTE on every new function in `public` to anon, authenticated and
-- service_role directly, and revoking from PUBLIC does not touch a direct
-- grant. So a signed-in student could call `release_coupon(uuid)` with the
-- coupon id readable on their own order and use a 100 % desk code again and
-- again; `redeem_coupon` skipped the app's rate limit; `unconfirmed_users`
-- handed out e-mail addresses; `expire_pending_orders('0')` cancelled every
-- checkout in progress. The local test harness created bare roles with no
-- default privileges, which is why 153 assertions never saw it.
--
-- The app never calls any of these through the user's client — pay.ts and the
-- sweep use the service role — so nothing the site does changes. The one
-- function that moves is `rate_limit_hit`: it was granted to anon because the
-- login form is used before sign-in, but a caller-chosen bucket and limit let
-- anyone fill another person's `login:<ip>` bucket. The limiter now calls it
-- as the service role (src/lib/rate-limit.ts), so it closes with the others.
--
-- The last statement changes the default for whatever comes next: a function
-- created later starts closed, and has to be opened on purpose, as every
-- user-callable function in this schema already is.
-- ---------------------------------------------------------------------------

revoke execute on function public.claim_confirmation_email(uuid)        from public, anon, authenticated;
revoke execute on function public.claim_due_installment_notices()       from public, anon, authenticated;
revoke execute on function public.claim_pack(uuid)                      from public, anon, authenticated;
revoke execute on function public.end_stale_live_sessions(integer)      from public, anon, authenticated;
revoke execute on function public.expire_entitlements()                 from public, anon, authenticated;
revoke execute on function public.expire_pending_orders(interval)       from public, anon, authenticated;
revoke execute on function public.grant_order_entitlements(uuid)        from public, anon, authenticated;
revoke execute on function public.prune_rate_limits()                   from public, anon, authenticated;
revoke execute on function public.redeem_coupon(text)                   from public, anon, authenticated;
revoke execute on function public.release_coupon(uuid)                  from public, anon, authenticated;
revoke execute on function public.release_order_holds(uuid)             from public, anon, authenticated;
revoke execute on function public.revoke_order_entitlements(uuid, text) from public, anon, authenticated;
revoke execute on function public.unconfirmed_users(interval)           from public, anon, authenticated;
revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;

-- Each keeps its service_role grant from the migration that created it; this
-- restates it so the file reads whole.
grant execute on function public.claim_confirmation_email(uuid)        to service_role;
grant execute on function public.claim_due_installment_notices()       to service_role;
grant execute on function public.claim_pack(uuid)                      to service_role;
grant execute on function public.end_stale_live_sessions(integer)      to service_role;
grant execute on function public.expire_entitlements()                 to service_role;
grant execute on function public.expire_pending_orders(interval)       to service_role;
grant execute on function public.grant_order_entitlements(uuid)        to service_role;
grant execute on function public.prune_rate_limits()                   to service_role;
grant execute on function public.redeem_coupon(text)                   to service_role;
grant execute on function public.release_coupon(uuid)                  to service_role;
grant execute on function public.release_order_holds(uuid)             to service_role;
grant execute on function public.revoke_order_entitlements(uuid, text) to service_role;
grant execute on function public.unconfirmed_users(interval)           to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- From here on a new function is nobody's until a grant says so. Two
-- statements, because of how Postgres builds a new object's privileges: a
-- per-schema default is merged ON TOP of the built-in default, and the
-- built-in default for a function grants EXECUTE to PUBLIC — so revoking
-- PUBLIC "in schema public" removes nothing. The global form is the one that
-- drops PUBLIC; the per-schema form drops the two API roles Supabase adds.
-- Both apply to functions created by the role running this file — the SQL
-- editor's `postgres`, which is also what runs every migration here.
--
-- One consequence to know about: a function created from now on by that role
-- in ANY schema has no PUBLIC grant, so if the school later enables a
-- Postgres extension whose functions the app must call as a visitor or a
-- student (this schema needs none today — ids come from the built-in
-- gen_random_uuid()), grant them on purpose:
--   grant execute on all functions in schema extensions to anon, authenticated;
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- One table the same defaults had quietly opened.
--
-- `contact_messages` was written so that `anon` could insert a message and
-- nothing else — the policy test even asserts the read is refused by the
-- GRANT, before any policy runs. Under Supabase's defaults `anon` held every
-- privilege on it from creation; RLS still returned no rows, but the stronger
-- guarantee the test describes was never in force. This is what it meant.
-- ---------------------------------------------------------------------------
revoke select, update, delete on public.contact_messages from anon;
