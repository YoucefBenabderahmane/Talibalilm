-- ---------------------------------------------------------------------------
-- Classes: who may see a group, who may join one, and which sessions it opens
--
-- A class is not a second paywall: holding the module is still required, and
-- membership is an additional condition on the same `can_join_live` the room
-- page, the token route, the slides and the chat all call. These assertions
-- prove the three things that would otherwise be silent:
--
--   * a student cannot join a class they were not admitted to, nor invent one;
--   * a session in another class of the SAME module is invisible and unjoinable;
--   * a membership can never name a class belonging to another module.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

create or replace function public.assert(ok boolean, what text)
returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', what; end if;
  raise notice '  ok  %', what;
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d0000000-0000-4000-8000-000000000001', 'classe-a@test.fr',   '{"full_name":"Classe A"}'::jsonb),
  ('d0000000-0000-4000-8000-000000000002', 'sans-classe@test.fr','{"full_name":"Sans classe"}'::jsonb),
  ('d0000000-0000-4000-8000-000000000003', 'classe-b@test.fr',   '{"full_name":"Classe B"}'::jsonb),
  ('d0000000-0000-4000-8000-000000000004', 'etranger@test.fr',   '{"full_name":"Etranger"}'::jsonb),
  ('d0000000-0000-4000-8000-000000000005', 'prof-classe@test.fr','{"full_name":"Prof"}'::jsonb);
update public.profiles set role = 'instructor' where id = 'd0000000-0000-4000-8000-000000000005';

insert into public.courses (id, slug, title, status, published_at) values
  ('e0000000-0000-4000-8000-000000000001', 'fiqh',   'Fiqh',   'published', now()),
  ('e0000000-0000-4000-8000-000000000002', 'hadith', 'Hadith', 'published', now());

-- Three buyers of Fiqh: one in each class and one not yet placed. The stranger
-- holds nothing.
insert into public.entitlements (user_id, scope, course_id, delivery, expires_at) values
  ('d0000000-0000-4000-8000-000000000001', 'course', 'e0000000-0000-4000-8000-000000000001', 'online', now() + interval '365 days'),
  ('d0000000-0000-4000-8000-000000000002', 'course', 'e0000000-0000-4000-8000-000000000001', 'online', now() + interval '365 days'),
  ('d0000000-0000-4000-8000-000000000003', 'course', 'e0000000-0000-4000-8000-000000000001', 'online', now() + interval '365 days');

insert into public.classes (id, course_id, name, schedule) values
  ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'Classe A', 'Samedi 9h–12h'),
  ('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'Classe B', 'Dimanche 9h–12h'),
  ('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000002', 'Classe Hadith', '');

insert into public.class_members (class_id, course_id, user_id) values
  ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001'),
  ('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000003');

insert into public.live_sessions (id, course_id, class_id, title, status) values
  ('a1110000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001', 'Fiqh — Classe A', 'live'),
  ('a1110000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000002', 'Fiqh — Classe B', 'live'),
  ('a1110000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000002',
   'f0000000-0000-4000-8000-000000000003', 'Hadith — Classe unique', 'live');

\echo ''
\echo '=== classes: building them is the office''s job ==='

do $$
declare made uuid; refused boolean := false;
begin
  raise notice 'staff build the groups';

  call auth.login_as('d0000000-0000-4000-8000-000000000005');
  insert into public.classes (course_id, name, schedule)
  values ('e0000000-0000-4000-8000-000000000001', 'Classe C', 'Mercredi 18h–21h')
  returning id into made;
  perform public.assert(made is not null, 'staff can create a class');

  update public.classes set schedule = 'Mercredi 17h–20h' where id = made;
  perform public.assert(
    (select schedule from public.classes where id = made) = 'Mercredi 17h–20h',
    'and edit its timetable');

  delete from public.classes where id = made;
  perform public.assert(
    (select count(*) from public.classes where id = made) = 0,
    'and delete one with no sessions');
  reset role;

  call auth.login_as('d0000000-0000-4000-8000-000000000001');
  begin
    insert into public.classes (course_id, name)
    values ('e0000000-0000-4000-8000-000000000001', 'Classe pirate');
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'a student cannot create one');

  -- No policy grants update, so the row is not even visible to the write and
  -- nothing changes — stronger than an exception, because it cannot be raced.
  update public.classes set name = 'Détournée'
   where id = 'f0000000-0000-4000-8000-000000000001';
  perform public.assert(
    (select name from public.classes where id = 'f0000000-0000-4000-8000-000000000001')
      = 'Classe A',
    'nor rename one');
  reset role;
end $$;

\echo ''
\echo '=== classes: who may see and join them ==='

do $$
declare n integer; refused boolean := false;
begin
  raise notice 'the list is part of what the module buys';

  call auth.login_as('d0000000-0000-4000-8000-000000000001');
  select count(*) into n from public.classes
   where course_id = 'e0000000-0000-4000-8000-000000000001';
  perform public.assert(n = 2, 'a buyer sees the classes of the module they hold');
  select count(*) into n from public.classes;
  perform public.assert(n = 2, 'and no class of a module they do not hold');
  reset role;

  call auth.login_as('d0000000-0000-4000-8000-000000000004');
  select count(*) into n from public.classes;
  perform public.assert(n = 0, 'a stranger sees no classes at all');
  reset role;

  call auth.login_as('d0000000-0000-4000-8000-000000000005');
  select count(*) into n from public.classes;
  perform public.assert(n = 3, 'staff see every class, sold or not');
  reset role;
end $$;

do $$
declare refused boolean := false;
begin
  raise notice 'joining is a student''s own act, in a module they hold';

  -- The unplaced buyer joins Class B, as themselves.
  call auth.login_as('d0000000-0000-4000-8000-000000000002');
  insert into public.class_members (class_id, course_id, user_id)
  values ('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001',
          'd0000000-0000-4000-8000-000000000002');
  perform public.assert(
    (select count(*) from public.class_members
      where user_id = 'd0000000-0000-4000-8000-000000000002') = 1,
    'a buyer joins the class they belong to');

  -- One class per module, from the unique index, not from a screen rule.
  refused := false;
  begin
    insert into public.class_members (class_id, course_id, user_id)
    values ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
            'd0000000-0000-4000-8000-000000000002');
  exception when unique_violation then refused := true;
  end;
  perform public.assert(refused, 'and cannot join a second one in the same module');

  -- Joining as somebody else is refused by the policy.
  refused := false;
  begin
    insert into public.class_members (class_id, course_id, user_id)
    values ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
            'd0000000-0000-4000-8000-000000000003');
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'and cannot place another student');

  -- A module they do not hold is closed even to joining.
  refused := false;
  begin
    insert into public.class_members (class_id, course_id, user_id)
    values ('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000002',
            'd0000000-0000-4000-8000-000000000002');
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'a class of a module they do not hold is refused');
  reset role;
end $$;

do $$
declare refused boolean := false; n integer;
begin
  raise notice 'a membership cannot point outside its module';

  -- The pair (Fiqh, Hadith class) does not exist, so the composite foreign key
  -- refuses it even for staff — a form bug cannot split the two.
  call auth.login_as('d0000000-0000-4000-8000-000000000005');
  begin
    insert into public.class_members (class_id, course_id, user_id)
    values ('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001',
            'd0000000-0000-4000-8000-000000000002');
  exception when foreign_key_violation then refused := true;
  end;
  perform public.assert(refused, 'a membership cannot name another module''s class');

  refused := false;
  begin
    insert into public.live_sessions (course_id, class_id, title)
    values ('e0000000-0000-4000-8000-000000000001',
            'f0000000-0000-4000-8000-000000000003', 'Séance mal rangée');
  exception when foreign_key_violation then refused := true;
  end;
  perform public.assert(refused, 'a session cannot be taught to another module''s class');

  refused := false;
  begin
    insert into public.live_sessions (course_id, title)
    values ('e0000000-0000-4000-8000-000000000001', 'Séance sans classe');
  exception when not_null_violation then refused := true;
  end;
  perform public.assert(refused, 'and every session must name a class');
  reset role;

  call auth.login_as('d0000000-0000-4000-8000-000000000001');
  select count(*) into n from public.class_members;
  perform public.assert(n = 1, 'a student sees only their own membership');
  reset role;

  call auth.login_as('d0000000-0000-4000-8000-000000000005');
  select count(*) into n from public.class_members;
  perform public.assert(n = 3, 'staff see the whole roster');
  reset role;
end $$;

\echo ''
\echo '=== classes: the room follows the group ==='

do $$
declare n integer;
begin
  raise notice 'a session belongs to one class, and only that class sees it';

  -- Class A holds one session; Class B holds the other; both are Fiqh.
  call auth.login_as('d0000000-0000-4000-8000-000000000001');
  select count(*) into n from public.live_sessions;
  perform public.assert(n = 1, 'the student in Class A sees exactly its session');
  perform public.assert(
    (select title from public.live_sessions) = 'Fiqh — Classe A',
    'which is the right one');
  perform public.assert(
    public.can_join_live('a1110000-0000-4000-8000-000000000001'),
    'and may join it');
  perform public.assert(
    not public.can_join_live('a1110000-0000-4000-8000-000000000002'),
    'but not the other class of the same module');
  reset role;

  call auth.login_as('d0000000-0000-4000-8000-000000000003');
  select count(*) into n from public.live_sessions;
  perform public.assert(n = 1, 'the student in Class B sees exactly its session');
  perform public.assert(
    (select title from public.live_sessions) = 'Fiqh — Classe B',
    'which is the other one');
  reset role;

  -- The unplaced buyer now holds a class (joined in the block above), so they
  -- are inside Class B's room and nowhere else.
  call auth.login_as('d0000000-0000-4000-8000-000000000002');
  select count(*) into n from public.live_sessions;
  perform public.assert(n = 1, 'a late joiner sees the class they joined');
  perform public.assert(
    public.can_join_live('a1110000-0000-4000-8000-000000000002'),
    'and can enter it');
  perform public.assert(
    not public.can_join_live('a1110000-0000-4000-8000-000000000001'),
    'while Class A stays shut');
  reset role;

  -- Staff are not put in a group: the whole module is theirs to run.
  call auth.login_as('d0000000-0000-4000-8000-000000000005');
  select count(*) into n from public.live_sessions;
  perform public.assert(n = 3, 'staff see every class''s sessions');
  perform public.assert(
    public.can_join_live('a1110000-0000-4000-8000-000000000001')
      and public.can_join_live('a1110000-0000-4000-8000-000000000002')
      and public.can_join_live('a1110000-0000-4000-8000-000000000003'),
    'and may enter any of them');
  reset role;
end $$;

do $$
declare refused boolean := false; n integer;
begin
  raise notice 'an unplaced student has the module but no room';

  -- Remove the late joiner from Class B: the entitlement is untouched, so the
  -- only thing that changed is the group.
  call auth.login_as('d0000000-0000-4000-8000-000000000005');
  delete from public.class_members
   where user_id = 'd0000000-0000-4000-8000-000000000002';
  perform public.assert(
    (select count(*) from public.class_members
      where user_id = 'd0000000-0000-4000-8000-000000000002') = 0,
    'the office can remove a student from a class');
  reset role;

  call auth.login_as('d0000000-0000-4000-8000-000000000002');
  perform public.assert(
    public.has_course_access('e0000000-0000-4000-8000-000000000001'),
    'the student still holds the module');
  select count(*) into n from public.live_sessions;
  perform public.assert(n = 0, 'but no session is visible without a class');
  perform public.assert(
    not public.can_join_live('a1110000-0000-4000-8000-000000000002'),
    'and no room opens');

  -- And they may join again, which is how a wrong click is undone.
  insert into public.class_members (class_id, course_id, user_id)
  values ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
          'd0000000-0000-4000-8000-000000000002');
  perform public.assert(
    public.can_join_live('a1110000-0000-4000-8000-000000000001'),
    'and joining another class opens that room');
  reset role;

  -- A class with sessions cannot be deleted out from under them.
  call auth.login_as('d0000000-0000-4000-8000-000000000005');
  refused := false;
  begin
    delete from public.classes where id = 'f0000000-0000-4000-8000-000000000001';
  exception when foreign_key_violation then refused := true;
  end;
  perform public.assert(refused, 'a class that has sessions cannot be deleted');
  reset role;
end $$;

do $$
declare refused boolean := false;
begin
  raise notice 'an expired entitlement still closes the room, membership or not';

  update public.entitlements
     set starts_at = now() - interval '400 days',
         expires_at = now() - interval '1 day'
   where user_id = 'd0000000-0000-4000-8000-000000000001';

  call auth.login_as('d0000000-0000-4000-8000-000000000001');
  perform public.assert(
    (select count(*) from public.class_members
      where user_id = 'd0000000-0000-4000-8000-000000000001') = 1,
    'the membership survives the expiry');
  perform public.assert(
    not public.can_join_live('a1110000-0000-4000-8000-000000000001'),
    'but the room does not open for last year''s student');
  reset role;
end $$;

drop function public.assert(boolean, text);

\echo ''
\echo 'ALL CLASS TESTS PASSED'
\echo ''
