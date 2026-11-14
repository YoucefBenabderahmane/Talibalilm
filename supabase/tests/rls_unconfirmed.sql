-- ---------------------------------------------------------------------------
-- Unconfirmed signups, and who may ask which accounts to delete.
--
-- `unconfirmed_users` is the list the sweep turns into deleted accounts, so
-- two things have to hold. Only the service role may ask for it, and the list
-- may never contain a confirmed student or one who has ordered: a lost
-- confirmation e-mail is not a reason to delete a paying customer, and
-- `orders.user_id` is `on delete restrict` — the refusal would otherwise be a
-- logged failure per account instead of a rule.
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

insert into auth.users (id, email, raw_user_meta_data, created_at, email_confirmed_at) values
  ('b0000000-0000-4000-8000-000000000001', 'spam-old@test.fr', '{}'::jsonb,
   now() - interval '3 days', null),
  ('b0000000-0000-4000-8000-000000000002', 'spam-new@test.fr', '{}'::jsonb,
   now() - interval '1 hour', null),
  ('b0000000-0000-4000-8000-000000000003', 'student@test.fr', '{}'::jsonb,
   now() - interval '3 days', now()),
  ('b0000000-0000-4000-8000-000000000004', 'buyer@test.fr', '{}'::jsonb,
   now() - interval '3 days', null);

-- The buyer paid at the desk and never confirmed: a real sale, not spam.
insert into public.orders (id, user_id, route, delivery) values
  ('b1110000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000004',
   'office', 'presentiel');

\echo ''
\echo '=== unconfirmed signups ==='

do $$
declare
  ids uuid[];
  refused boolean := false;
begin
  raise notice 'only the service role may ask for accounts to delete';

  call auth.login_as('b0000000-0000-4000-8000-000000000003');
  begin
    perform public.unconfirmed_users(interval '2 days');
  exception when insufficient_privilege then refused := true;
  end;
  execute 'reset role';
  perform public.assert(refused, 'an authenticated user cannot list accounts for deletion');

  execute 'set local role service_role';
  select array_agg(id order by id) into ids from public.unconfirmed_users(interval '2 days');
  execute 'reset role';

  -- `coalesce` so an empty list fails the assertion rather than making it null.
  perform public.assert(
    coalesce(ids, '{}') = array['b0000000-0000-4000-8000-000000000001'::uuid],
    'the list is the old unconfirmed account, and only it');

  perform public.assert(
    not exists (
      select 1 from public.unconfirmed_users(interval '2 days') u
      where u.id in ('b0000000-0000-4000-8000-000000000002',
                     'b0000000-0000-4000-8000-000000000003',
                     'b0000000-0000-4000-8000-000000000004')
    ),
    'a fresh signup, a confirmed student and a buyer are all kept');
end $$;

drop function public.assert(boolean, text);

\echo ''
\echo 'ALL UNCONFIRMED CLEANUP TESTS PASSED'
\echo ''
