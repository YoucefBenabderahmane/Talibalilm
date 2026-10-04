-- ---------------------------------------------------------------------------
-- The shared deck catalogue
--
-- A rendered PDF is stored once, under its fingerprint, and every class that
-- teaches it attaches the same objects. These assertions prove the two halves
-- that make that safe:
--
--   * the catalogue is staff-only — a student cannot read or write it;
--   * a slide row may name a shared deck object, two sessions may hold the
--     same object, and a malformed key is still refused by the CHECK.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

create or replace function public.assert(ok boolean, what text)
returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', what; end if;
  raise notice '  ok  %', what;
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d2000000-0000-4000-8000-000000000001', 'eleve@test.fr',    '{"full_name":"Eleve"}'::jsonb),
  ('d2000000-0000-4000-8000-000000000002', 'etranger@test.fr', '{"full_name":"Etranger"}'::jsonb),
  ('d2000000-0000-4000-8000-000000000003', 'prof@test.fr',     '{"full_name":"Prof"}'::jsonb);
update public.profiles set role = 'instructor' where id = 'd2000000-0000-4000-8000-000000000003';

insert into public.courses (id, slug, title, status, published_at) values
  ('e2000000-0000-4000-8000-000000000001', 'fiqh', 'Fiqh', 'published', now());

insert into public.entitlements (user_id, scope, course_id, delivery, expires_at) values
  ('d2000000-0000-4000-8000-000000000001', 'course', 'e2000000-0000-4000-8000-000000000001', 'online', now() + interval '365 days');

insert into public.classes (id, course_id, name) values
  ('f2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Classe A'),
  ('f2000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'Classe B');

insert into public.class_members (class_id, course_id, user_id) values
  ('f2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001');

insert into public.live_sessions (id, course_id, class_id, title, status) values
  ('a2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001',
   'f2000000-0000-4000-8000-000000000001', 'Classe A — direct', 'live'),
  ('a2000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001',
   'f2000000-0000-4000-8000-000000000002', 'Classe B — direct', 'live');

-- One rendered PDF, shared by both classes.
insert into public.deck_catalog (fingerprint, page_count, pages) values
  ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1,
   '[{"key":"decks/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/abcd1234efgh.webp","filename":"plan-1.webp","mimeType":"image/webp","byteSize":100}]'::jsonb);

-- The same object named by two sessions. This used to be impossible: the key
-- was UNIQUE and pinned to one session's prefix.
insert into public.live_slides (session_id, storage_key, filename, mime_type, byte_size, display_order) values
  ('a2000000-0000-4000-8000-000000000001',
   'decks/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/abcd1234efgh.webp',
   'plan-1.webp', 'image/webp', 100, 0),
  ('a2000000-0000-4000-8000-000000000002',
   'decks/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/abcd1234efgh.webp',
   'plan-1.webp', 'image/webp', 100, 0);

\echo ''
\echo '=== the deck catalogue is the office''s ==='

do $$
declare n integer; refused boolean := false;
begin
  call auth.login_as('d2000000-0000-4000-8000-000000000001');
  select count(*) into n from public.deck_catalog;
  perform public.assert(n = 0, 'a student reads no catalogue row');

  begin
    insert into public.deck_catalog (fingerprint, page_count, pages)
    values (repeat('b', 64), 1, '[]'::jsonb);
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'and cannot write one');
  reset role;

  call auth.login_as('d2000000-0000-4000-8000-000000000003');
  select count(*) into n from public.deck_catalog;
  perform public.assert(n = 1, 'staff read the catalogue');
  reset role;
end $$;

\echo ''
\echo '=== a slide row may name a shared deck object ==='

do $$
declare n integer; refused boolean := false;
begin
  call auth.login_as('d2000000-0000-4000-8000-000000000001');
  select count(*) into n from public.live_slides;
  perform public.assert(n = 1, 'the student sees their own class''s shared slide');
  reset role;

  call auth.login_as('d2000000-0000-4000-8000-000000000002');
  select count(*) into n from public.live_slides;
  perform public.assert(n = 0, 'a stranger sees nothing, shared object or not');
  reset role;

  -- The key shape is still enforced: a fingerprint that is not a sha-256, or a
  -- file a browser would execute, never becomes a row.
  begin
    insert into public.live_slides (session_id, storage_key, filename, mime_type, byte_size, display_order)
    values ('a2000000-0000-4000-8000-000000000001', 'decks/short/abcd1234efgh.png',
            'x.png', 'image/png', 100, 1);
  exception when check_violation then refused := true;
  end;
  perform public.assert(refused, 'a malformed deck key is refused');

  refused := false;
  begin
    insert into public.live_slides (session_id, storage_key, filename, mime_type, byte_size, display_order)
    values ('a2000000-0000-4000-8000-000000000001',
            'decks/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/payload12.html',
            'x.html', 'image/png', 100, 1);
  exception when check_violation then refused := true;
  end;
  perform public.assert(refused, 'and so is a page that is not an image');
end $$;

drop function public.assert(boolean, text);

\echo ''
\echo 'ALL DECK CATALOGUE TESTS PASSED'
\echo ''
