-- ---------------------------------------------------------------------------
-- Who may say that a student attended a class.
--
-- The student's dashboard now shows "Présent", "Absent" or "Excusé" for each
-- class of their group. The automatic answer comes from rows the student can
-- already read — their group's ended sessions and their own attendance row —
-- and a teacher's correction sits in `live_attendance_marks`.
--
-- The thing that must hold: a student cannot write there. One who could would
-- mark themselves present at every class they missed. And a correction is
-- signed by the teacher who made it, not by whoever they name.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

create or replace function public.assert(ok boolean, what text)
returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', what; end if;
  raise notice '  ok  %', what;
end $$;
grant execute on function public.assert(boolean, text) to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-4000-8000-000000000001', 'amina@test.fr',    '{"full_name":"Amina"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000002', 'bilal@test.fr',    '{"full_name":"Bilal"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000003', 'prof@test.fr',     '{"full_name":"Prof"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000004', 'collegue@test.fr', '{"full_name":"Collegue"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000005', 'stranger@test.fr', '{"full_name":"Etranger"}'::jsonb);
update public.profiles set role = 'instructor'
 where id in ('a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000004');

insert into public.courses (id, slug, title, status, published_at) values
  ('c0000000-0000-4000-8000-000000000001', 'fiqh', 'Fiqh', 'published', now());

insert into public.entitlements (user_id, scope, course_id, delivery, expires_at) values
  ('a0000000-0000-4000-8000-000000000001', 'course',
   'c0000000-0000-4000-8000-000000000001', 'online', now() + interval '365 days'),
  ('a0000000-0000-4000-8000-000000000002', 'course',
   'c0000000-0000-4000-8000-000000000001', 'online', now() + interval '365 days');

insert into public.classes (id, course_id, name) values
  ('aa110000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'Classe A');

-- Both students sit in the group, since before the classes below.
insert into public.class_members (class_id, course_id, user_id, joined_at) values
  ('aa110000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001', now() - interval '30 days'),
  ('aa110000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000002', now() - interval '30 days');

-- Two classes that happened. Bilal opened the first; nobody opened the second.
insert into public.live_sessions
  (id, course_id, class_id, title, status, scheduled_at, started_at, ended_at) values
  ('11110000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'aa110000-0000-4000-8000-000000000001', 'Séance 1', 'ended',
   now() - interval '8 days', now() - interval '8 days', now() - interval '8 days' + interval '2 hours'),
  ('11110000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001',
   'aa110000-0000-4000-8000-000000000001', 'Séance 2', 'ended',
   now() - interval '1 day', now() - interval '1 day', now() - interval '1 day' + interval '2 hours');

insert into public.live_participants (session_id, user_id, role, joined_at) values
  ('11110000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
   'participant', now() - interval '8 days' + interval '3 minutes');

\echo ''
\echo '=== what the automatic answer is read from ==='

do $$
declare n integer;
begin
  -- The student view is built from these two reads. If a later change hid an
  -- ended class from its own group, or a student's own attendance row from
  -- them, every class would silently read "absent" — so they are pinned here.
  call auth.login_as('a0000000-0000-4000-8000-000000000001');
  select count(*) into n from public.live_sessions where status = 'ended';
  perform public.assert(n = 2, 'a student still sees the classes of their group once they have ended');
  select count(*) into n from public.live_participants;
  perform public.assert(n = 0, 'a student who opened no room has no attendance row, and sees nobody else''s');
  reset role;

  call auth.login_as('a0000000-0000-4000-8000-000000000002');
  select count(*) into n from public.live_participants
   where session_id = '11110000-0000-4000-8000-000000000001';
  perform public.assert(n = 1, 'a student who opened the room reads their own attendance row');
  reset role;

  call auth.login_as('a0000000-0000-4000-8000-000000000005');
  select count(*) into n from public.live_sessions;
  perform public.assert(n = 0, 'a stranger sees no class at all');
  reset role;
end $$;

\echo ''
\echo '=== corrections ==='

do $$
declare refused boolean := false; n integer; got public.attendance_status;
begin
  raise notice 'a student cannot write their own attendance';

  call auth.login_as('a0000000-0000-4000-8000-000000000001');
  begin
    insert into public.live_attendance_marks (session_id, user_id, status, marked_by)
    values ('11110000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
            'present', 'a0000000-0000-4000-8000-000000000001');
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  perform public.assert(refused, 'a student cannot mark themselves present');

  select count(*) into n from public.live_attendance_marks;
  perform public.assert(n = 0, 'and nothing was written');
end $$;

do $$
declare refused boolean := false; n integer;
begin
  raise notice 'staff correct it, under their own name';

  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  insert into public.live_attendance_marks (session_id, user_id, status, marked_by)
  values ('11110000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
          'excused', 'a0000000-0000-4000-8000-000000000003');
  select count(*) into n from public.live_attendance_marks;
  perform public.assert(n = 1, 'a teacher can excuse a student');

  begin
    insert into public.live_attendance_marks (session_id, user_id, status, marked_by)
    values ('11110000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
            'present', 'a0000000-0000-4000-8000-000000000004');
  exception when insufficient_privilege then refused := true;
  end;
  perform public.assert(refused, 'but cannot sign the correction with a colleague''s name');
  reset role;
end $$;

do $$
declare n integer; got public.attendance_status;
begin
  raise notice 'the student reads it and cannot touch it';

  call auth.login_as('a0000000-0000-4000-8000-000000000001');
  select status into got from public.live_attendance_marks
   where session_id = '11110000-0000-4000-8000-000000000001';
  perform public.assert(got = 'excused', 'the student sees the correction about them');

  update public.live_attendance_marks set status = 'present'
   where user_id = 'a0000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  perform public.assert(n = 0, 'cannot turn it into "present"');

  delete from public.live_attendance_marks
   where user_id = 'a0000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  perform public.assert(n = 0, 'and cannot remove it');
  reset role;

  select status into got from public.live_attendance_marks
   where session_id = '11110000-0000-4000-8000-000000000001';
  perform public.assert(got = 'excused', 'the correction stands as the teacher wrote it');

  call auth.login_as('a0000000-0000-4000-8000-000000000002');
  select count(*) into n from public.live_attendance_marks;
  perform public.assert(n = 0, 'another student of the same group does not see it');
  reset role;
end $$;

do $$
declare refused boolean := false;
begin
  call auth.logout();
  begin
    perform 1 from public.live_attendance_marks;
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  perform public.assert(refused, 'a signed-out visitor is refused the table outright');
end $$;

do $$
declare n integer; who uuid; got public.attendance_status;
begin
  raise notice 'a colleague can change it, and it then carries their name';

  call auth.login_as('a0000000-0000-4000-8000-000000000004');
  update public.live_attendance_marks
     set status = 'absent', marked_by = 'a0000000-0000-4000-8000-000000000004', marked_at = now()
   where session_id = '11110000-0000-4000-8000-000000000001'
     and user_id = 'a0000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  reset role;
  perform public.assert(n = 1, 'another teacher can change the correction');
  select status, marked_by into got, who from public.live_attendance_marks
   where session_id = '11110000-0000-4000-8000-000000000001';
  perform public.assert(
    got = 'absent' and who = 'a0000000-0000-4000-8000-000000000004',
    'and it is signed by the one who changed it');

  call auth.login_as('a0000000-0000-4000-8000-000000000003');
  delete from public.live_attendance_marks
   where session_id = '11110000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  reset role;
  perform public.assert(n = 1, 'removing it returns the class to the automatic answer');
end $$;

do $$
declare n integer;
begin
  raise notice 'a correction does not outlive its class';

  insert into public.live_attendance_marks (session_id, user_id, status, marked_by)
  values ('11110000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
          'excused', 'a0000000-0000-4000-8000-000000000003');
  delete from public.live_sessions where id = '11110000-0000-4000-8000-000000000002';
  select count(*) into n from public.live_attendance_marks;
  perform public.assert(n = 0, 'deleting the class removes its corrections');
end $$;

\echo ''
\echo 'attendance: all assertions passed'
