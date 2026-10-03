-- ---------------------------------------------------------------------------
-- Lesson content belongs to a class
--
-- A module runs several times, for different groups — the school's "décalage".
-- Class A is on lesson 3 while class B is on lesson 1, and the recording of a
-- lesson, its written support and its links are those of the group that was
-- taught, not of the module. Until now all of it lived in `lesson_content`,
-- keyed by the lesson alone, so every class shared one text and one video and
-- the groups mixed.
--
-- `lesson_content` stays, and stays exactly as it was, for the one reader who
-- has no class: a public preview lesson. Everything an enrolled student sees
-- now comes from `class_lesson_content`, which is scoped to their group.
--
-- The row is not a second paywall. `has_lesson_access(lesson_id)` is still the
-- gate; class membership is an additional condition on the same question.
-- ---------------------------------------------------------------------------

create table public.class_lesson_content (
  id                 uuid primary key default gen_random_uuid(),
  class_id           uuid not null references public.classes (id) on delete cascade,
  lesson_id          uuid not null references public.lessons (id) on delete cascade,
  content            text not null default '',
  video_provider     public.video_provider not null default 'none',
  -- Never a playable URL: an opaque id the server exchanges for a short-lived
  -- signed URL at request time. Storing a URL here would make a leak permanent.
  video_id           text,
  video_bytes        bigint not null default 0,
  video_uploaded_at  timestamptz,
  video_expires_at   timestamptz,
  attachments        jsonb not null default '[]'::jsonb,
  uploaded_by        uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- One row per group per lesson: the recording of a lesson as it was taught.
  unique (class_id, lesson_id),

  constraint class_lesson_content_attachments_is_array check (jsonb_typeof(attachments) = 'array'),
  constraint class_lesson_content_video_id_not_url
    check (video_id is null or video_id !~* '^https?://')
);

create index class_lesson_content_lesson_idx on public.class_lesson_content (lesson_id);
create index class_lesson_content_class_idx on public.class_lesson_content (class_id);

-- The sweep reads exactly this: rows with a retention date that has passed.
create index class_lesson_content_video_expiry_idx
  on public.class_lesson_content (video_expires_at)
  where video_expires_at is not null;

create trigger class_lesson_content_touch_updated_at
  before update on public.class_lesson_content
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Which lesson the group is on
--
-- The office's answer to "where is this class?", shown to students on the
-- class card so they recognise their group's position. Null until the office
-- sets it; deleting a lesson clears it rather than refusing the delete.
-- ---------------------------------------------------------------------------

alter table public.classes
  add column if not exists current_lesson_id uuid references public.lessons (id) on delete set null;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.class_lesson_content enable row level security;
alter table public.class_lesson_content force row level security;

revoke all on public.class_lesson_content from anon, authenticated;
grant select, insert, update, delete on public.class_lesson_content to authenticated;

-- A student reads the content of their own group, in a lesson they can open.
-- Not another group's, not a module they do not hold.
create policy class_lesson_content_select_member on public.class_lesson_content for select
  to authenticated
  using (
    public.is_staff()
    or (
      public.has_lesson_access(lesson_id)
      and exists (
        select 1 from public.class_members m
        where m.class_id = class_lesson_content.class_id
          and m.user_id = auth.uid()
      )
    )
  );

create policy class_lesson_content_write_staff on public.class_lesson_content for all
  to authenticated using (public.is_staff()) with check (public.is_staff());

-- ---------------------------------------------------------------------------
-- Backfill
--
-- Every existing text and upload is copied to the course's FIRST class, so a
-- project that has been teaching keeps its material. A course with content but
-- no class is left alone: the office creates the groups first, and the lesson
-- page says so rather than inventing a class nobody asked for.
-- ---------------------------------------------------------------------------

insert into public.class_lesson_content
  (class_id, lesson_id, content, video_provider, video_id, video_bytes,
   video_uploaded_at, video_expires_at, attachments)
select first_class.id, lc.lesson_id, lc.content, lc.video_provider, lc.video_id,
       lc.video_bytes, lc.video_uploaded_at, lc.video_expires_at, lc.attachments
from public.lesson_content lc
join public.lessons l on l.id = lc.lesson_id
join public.modules m on m.id = l.module_id
join lateral (
  select c.id
  from public.classes c
  where c.course_id = m.course_id
  order by c.position, c.name
  limit 1
) first_class on true
on conflict (class_id, lesson_id) do nothing;

-- ---------------------------------------------------------------------------
-- The storage figure the admin overview shows now counts both homes.
-- ---------------------------------------------------------------------------

create or replace function public.lesson_video_total_bytes()
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.is_staff() then
    coalesce((select sum(video_bytes) from public.lesson_content), 0)
    + coalesce((select sum(video_bytes) from public.class_lesson_content), 0)
  else 0 end;
$$;

revoke all on function public.lesson_video_total_bytes() from public;
grant execute on function public.lesson_video_total_bytes() to authenticated, service_role;
