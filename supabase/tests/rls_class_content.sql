-- ---------------------------------------------------------------------------
-- Class-scoped lesson content: one group cannot read another's
--
-- A lesson's text, recording and link belong to the class it was taught to.
-- Class A is on lesson 3 while class B is on lesson 1, and the material must
-- not mix. These assertions prove the three things that would otherwise be
-- silent:
--
--   * a student reads only their own class's row, never the other group's;
--   * holding the module without a class reads nothing (the row is the group's,
--     not the module's);
--   * nobody but staff can write one.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

create or replace function public.assert(ok boolean, what text)
returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', what; end if;
  raise notice '  ok  %', what;
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d1000000-0000-4000-8000-000000000001', 'classe-a@test.fr',    '{"full_name":"Classe A"}'::jsonb),
  ('d1000000-0000-4000-8000-000000000002', 'classe-b@test.fr',    '{"full_name":"Classe B"}'::jsonb),
  ('d1000000-0000-4000-8000-000000000003', 'sans-classe@test.fr', '{"full_name":"Sans classe"}'::jsonb),
  ('d1000000-0000-4000-8000-000000000004', 'etranger@test.fr',    '{"full_name":"Etranger"}'::jsonb),
  ('d1000000-0000-4000-8000-000000000005', 'prof@test.fr',        '{"full_name":"Prof"}'::jsonb);
update public.profiles set role = 'instructor' where id = 'd1000000-0000-4000-8000-000000000005';

insert into public.courses (id, slug, title, status, published_at) values
  ('e1000000-0000-4000-8000-000000000001', 'fiqh', 'Fiqh', 'published', now());

-- Three buyers: one in each group, one unplaced. The stranger holds nothing.
insert into public.entitlements (user_id, scope, course_id, delivery, expires_at) values
  ('d1000000-0000-4000-8000-000000000001', 'course', 'e1000000-0000-4000-8000-000000000001', 'online', now() + interval '365 days'),
  ('d1000000-0000-4000-8000-000000000002', 'course', 'e1000000-0000-4000-8000-000000000001', 'online', now() + interval '365 days'),
  ('d1000000-0000-4000-8000-000000000003', 'course', 'e1000000-0000-4000-8000-000000000001', 'online', now() + interval '365 days');

insert into public.classes (id, course_id, name) values
  ('f1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'Classe A'),
  ('f1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'Classe B');

insert into public.class_members (class_id, course_id, user_id) values
  ('f1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001'),
  ('f1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002');

insert into public.modules (id, course_id, title, position) values
  ('a1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'Chapitre 1', 1);

insert into public.lessons (id, module_id, title, slug, type, position) values
  ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Leçon 1', 'lecon-1', 'video', 1),
  ('b1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'Leçon 2', 'lecon-2', 'video', 2);

-- The two groups were taught the same lesson differently. Class A is ahead.
insert into public.class_lesson_content
  (class_id, lesson_id, content, video_provider, video_id, video_bytes) values
  ('f1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Support de la classe A', 'r2', 'lessons/lecon-1/a.mp4', 1000),
  ('f1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', 'A — leçon 2', 'youtube', 'dQw4w9WgXcQ', 0),
  ('f1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'Support de la classe B', 'r2', 'lessons/lecon-1/b.mp4', 2000);

-- The office says where each group is.
update public.classes set current_lesson_id = 'b1000000-0000-4000-8000-000000000002'
 where id = 'f1000000-0000-4000-8000-000000000001';
update public.classes set current_lesson_id = 'b1000000-0000-4000-8000-000000000001'
 where id = 'f1000000-0000-4000-8000-000000000002';

\echo ''
\echo '=== class content: each group reads only its own ==='

do $$
declare n integer; body text;
begin
  call auth.login_as('d1000000-0000-4000-8000-000000000001');
  select count(*) into n from public.class_lesson_content;
  perform public.assert(n = 2, 'the student in Class A sees exactly their group''s two rows');
  select content into body from public.class_lesson_content
   where lesson_id = 'b1000000-0000-4000-8000-000000000001';
  perform public.assert(body = 'Support de la classe A', 'and it is their group''s text');
  perform public.assert(
    not exists (
      select 1 from public.class_lesson_content
      where class_id = 'f1000000-0000-4000-8000-000000000002'
    ),
    'never the other group''s, even by id');
  reset role;

  call auth.login_as('d1000000-0000-4000-8000-000000000002');
  select count(*) into n from public.class_lesson_content;
  perform public.assert(n = 1, 'the student in Class B sees only their one row');
  select content into body from public.class_lesson_content
   where lesson_id = 'b1000000-0000-4000-8000-000000000001';
  perform public.assert(body = 'Support de la classe B', 'which is their group''s text');
  reset role;
end $$;

do $$
declare n integer;
begin
  raise notice 'holding the module is not enough without a group';

  call auth.login_as('d1000000-0000-4000-8000-000000000003');
  select count(*) into n from public.class_lesson_content;
  perform public.assert(n = 0, 'an unplaced buyer reads no class content at all');
  perform public.assert(
    public.has_lesson_access('b1000000-0000-4000-8000-000000000001'),
    'even though the lesson itself is theirs to open');
  reset role;

  call auth.login_as('d1000000-0000-4000-8000-000000000004');
  select count(*) into n from public.class_lesson_content;
  perform public.assert(n = 0, 'a stranger reads nothing');
  reset role;

  call auth.login_as('d1000000-0000-4000-8000-000000000005');
  select count(*) into n from public.class_lesson_content;
  perform public.assert(n = 3, 'staff see every group''s rows');
  reset role;
end $$;

do $$
declare refused boolean := false;
begin
  raise notice 'writing is the office''s job';

  call auth.login_as('d1000000-0000-4000-8000-000000000001');
  begin
    insert into public.class_lesson_content (class_id, lesson_id, content)
    values ('f1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', 'Pirate');
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'a student cannot write another group''s content');

  -- No update policy for a student: the row is not visible to the write and
  -- nothing changes — stronger than an exception, because it cannot be raced.
  update public.class_lesson_content set content = 'Détourné'
   where class_id = 'f1000000-0000-4000-8000-000000000001';
  perform public.assert(
    (select content from public.class_lesson_content
      where class_id = 'f1000000-0000-4000-8000-000000000001'
        and lesson_id = 'b1000000-0000-4000-8000-000000000001')
      = 'Support de la classe A',
    'nor edit their own');
  reset role;
end $$;

do $$
declare n integer; title text;
begin
  raise notice 'the group knows where it is';

  call auth.login_as('d1000000-0000-4000-8000-000000000001');
  select c.current_lesson_id into title from public.classes c
   where c.id = 'f1000000-0000-4000-8000-000000000001';
  perform public.assert(
    title = 'b1000000-0000-4000-8000-000000000002',
    'Class A reads its own current lesson');
  select count(*) into n from public.classes
   where id = 'f1000000-0000-4000-8000-000000000002';
  perform public.assert(n = 1, 'and the classes list is the module''s, as before');
  reset role;
end $$;

-- The expiry gate still decides, class or not: last year's student reads
-- nothing even while their membership survives.
do $$
declare n integer;
begin
  raise notice 'an expired entitlement closes the content, membership or not';

  update public.entitlements
     set starts_at = now() - interval '400 days',
         expires_at = now() - interval '1 day'
   where user_id = 'd1000000-0000-4000-8000-000000000001';

  call auth.login_as('d1000000-0000-4000-8000-000000000001');
  perform public.assert(
    (select count(*) from public.class_members
      where user_id = 'd1000000-0000-4000-8000-000000000001') = 1,
    'the membership survives the expiry');
  select count(*) into n from public.class_lesson_content;
  perform public.assert(n = 0, 'but the class content does not');
  reset role;
end $$;

drop function public.assert(boolean, text);

\echo ''
\echo 'ALL CLASS CONTENT TESTS PASSED'
\echo ''
