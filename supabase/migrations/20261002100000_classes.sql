-- ---------------------------------------------------------------------------
-- Classes: the group of students a live session is taught to
--
-- A module runs several times, at different hours, for different groups — the
-- school's "décalage". Until now a live session belonged to the whole course,
-- so every buyer saw every session and could walk into the wrong one. A class
-- is a named group inside a module, with its own timetable text; a student
-- joins the one they belong to, and a session is taught to exactly one class.
--
-- This is not a second paywall. The gate is still `has_course_access`, and the
-- membership is an ADDITIONAL condition on the same function the room page,
-- the token route, the slides, the chat and the board all already call. Hold
-- the course but not the class, and the room stays shut; hold the class but
-- not the course, and the entitlement still decides.
--
-- The order matters: `classes` and `class_members` first, then the backfill
-- that gives every existing session a class, then the policies that read them.
-- ---------------------------------------------------------------------------

create table public.classes (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses (id) on delete cascade,
  name       text not null,
  -- Free text, like `courses.schedule`: "Samedi 9h–12h". Shown to students so
  -- they can recognise the group they were told to join.
  schedule   text not null default '',
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint classes_name_present check (btrim(name) <> ''),
  constraint classes_name_len check (char_length(name) <= 120),
  constraint classes_schedule_len check (char_length(schedule) <= 200),

  unique (course_id, name),

  -- The target of the composite foreign keys below. `id` alone is already
  -- unique; pairing it with `course_id` is what lets a session (and a
  -- membership) prove IN THE DATABASE that its class belongs to its course,
  -- instead of trusting whichever screen wrote the row.
  unique (course_id, id)
);

create index classes_course_idx on public.classes (course_id, position);

create trigger classes_touch_updated_at
  before update on public.classes
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Who is in which class
--
-- One class per student per module, enforced by `unique (user_id, course_id)`
-- rather than by a rule in an action: the office can move a student by
-- deleting and re-adding, but a student cannot sit in two groups at once and
-- collect both timetables. `course_id` is carried here so that constraint is
-- expressible, and the composite foreign key keeps it honest.
-- ---------------------------------------------------------------------------

create table public.class_members (
  class_id  uuid not null,
  course_id uuid not null,
  user_id   uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),

  primary key (class_id, user_id),
  unique (user_id, course_id),

  foreign key (course_id, class_id)
    references public.classes (course_id, id) on delete cascade
);

create index class_members_user_idx on public.class_members (user_id);
create index class_members_course_idx on public.class_members (course_id);

-- ---------------------------------------------------------------------------
-- Every session belongs to a class
--
-- Sessions that predate this migration get one default class per course, so
-- the column can be made mandatory without deleting the school's history. The
-- office renames it and creates the other groups from the module builder.
-- ---------------------------------------------------------------------------

insert into public.classes (course_id, name, schedule, position)
select distinct s.course_id, 'Classe 1', '', 0
  from public.live_sessions s
 where not exists (
   select 1 from public.classes c where c.course_id = s.course_id
 );

alter table public.live_sessions add column class_id uuid;

update public.live_sessions s
   set class_id = c.id
  from public.classes c
 where c.course_id = s.course_id
   and c.name = 'Classe 1'
   and s.class_id is null;

alter table public.live_sessions alter column class_id set not null;

-- Composite: the class must belong to the session's own course. A mismatch is
-- refused here, so `createLiveSession` cannot file a Fiqh class under Hadith
-- even if the form posted the wrong pair.
alter table public.live_sessions
  add constraint live_sessions_class_fk
  foreign key (course_id, class_id)
  references public.classes (course_id, id);

create index live_sessions_class_idx on public.live_sessions (class_id, scheduled_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.classes enable row level security;
alter table public.classes force row level security;
alter table public.class_members enable row level security;
alter table public.class_members force row level security;

revoke all on public.classes from anon, authenticated;
revoke all on public.class_members from anon, authenticated;

grant select on public.classes to authenticated;
grant insert, update, delete on public.classes to authenticated;
grant select, insert, delete on public.class_members to authenticated;

-- A buyer sees the groups of a module they hold — that is the list they choose
-- from. Nobody else sees the school's internal groupings.
create policy classes_select_entitled on public.classes for select
  to authenticated
  using (public.has_course_access(course_id) or public.is_staff());

create policy classes_write_staff on public.classes for all
  to authenticated using (public.is_staff()) with check (public.is_staff());

create policy class_members_select_own on public.class_members for select
  to authenticated using (user_id = auth.uid() or public.is_staff());

-- Joining is a student's own act, as themselves, only in a module they hold.
-- The composite foreign key decides which class; this decides who.
create policy class_members_join_own on public.class_members for insert
  to authenticated
  with check (user_id = auth.uid() and public.has_course_access(course_id));

-- Leaving is the same act in reverse, and the office may remove anyone.
create policy class_members_leave_own on public.class_members for delete
  to authenticated using (user_id = auth.uid() or public.is_staff());

-- ---------------------------------------------------------------------------
-- The gate, narrowed by membership
--
-- Same table, same function names as before; the only change is that a student
-- must also be in the session's class. Staff keep the whole course.
-- ---------------------------------------------------------------------------

drop policy live_sessions_select_entitled on public.live_sessions;

create policy live_sessions_select_class on public.live_sessions for select
  to authenticated
  using (
    public.is_staff()
    or (
      public.has_course_access(course_id)
      and exists (
        select 1 from public.class_members m
        where m.class_id = live_sessions.class_id
          and m.user_id = auth.uid()
      )
    )
  );

create or replace function public.can_join_live(session_id uuid, uid uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.live_sessions s
    where s.id = session_id
      and s.status in ('scheduled', 'live')
      and (
        public.is_staff(uid)
        or (
          public.has_course_access(s.course_id, uid)
          and exists (
            select 1 from public.class_members m
            where m.class_id = s.class_id and m.user_id = uid
          )
        )
      )
  )
  and not exists (
    -- Staff are never banned from their own class; the check is for students.
    select 1 from public.live_participants p
    where p.session_id = can_join_live.session_id
      and p.user_id = uid
      and p.banned_at is not null
      and not public.is_staff(uid)
  );
$$;

revoke all on function public.can_join_live(uuid, uuid) from public;
grant execute on function public.can_join_live(uuid, uuid) to authenticated, service_role;

-- Knocking at the door is the same answer as entering it. This feature is not
-- wired to a screen yet, but the policy must not become the one path that
-- forgot the class.
drop policy live_join_requests_insert_own on public.live_join_requests;

create policy live_join_requests_insert_own on public.live_join_requests for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.live_sessions s
      join public.class_members m
        on m.class_id = s.class_id and m.user_id = auth.uid()
      where s.id = session_id
        and public.has_course_access(s.course_id)
    )
  );
