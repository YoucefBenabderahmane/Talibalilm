-- ---------------------------------------------------------------------------
-- Attendance a teacher can correct.
--
-- What the school asked for: a student who is in a group and did not come to
-- one of its live classes should see that they were absent. The record of who
-- came already exists — `live_participants`, one row per student per class,
-- written when they open the room — so "absent" is simply a class of their
-- group that has ended with no such row. Nothing needs storing for that.
--
-- What does need storing is the teacher's word against the record. The room
-- only knows who opened it online: a student who followed the class on site
-- never appears, and one whose connection failed did attend as far as the
-- teacher is concerned. Without a way to say so, the site would tell those
-- students they were absent and nobody could put it right.
--
-- So this table holds corrections and nothing else: at most one per student
-- per class, written by staff, read by the student it is about. Where a row
-- exists it wins over the automatic answer; deleting it returns the class to
-- the automatic answer. The automatic answer is never copied in here — a
-- table that had to be kept in step with `live_participants` would be a
-- second record of the same fact, free to disagree with the first.
-- ---------------------------------------------------------------------------

create type public.attendance_status as enum ('present', 'absent', 'excused');

create table public.live_attendance_marks (
  session_id uuid not null references public.live_sessions (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  status     public.attendance_status not null,
  -- Who said so. Kept when the teacher's account goes: the correction is the
  -- school's, and the student's record must not change because a teacher left.
  marked_by  uuid references public.profiles (id) on delete set null,
  marked_at  timestamptz not null default now(),

  primary key (session_id, user_id)
);

create index live_attendance_marks_user_idx on public.live_attendance_marks (user_id);

comment on table public.live_attendance_marks is
  'A teacher''s correction of one student''s attendance at one live class. Absent a row, attendance is whether live_participants has one.';

-- ---------------------------------------------------------------------------
-- RLS
--
-- A student reads the corrections about themselves and writes none: a student
-- who could insert here could mark themselves present. Staff read and write
-- them all, and a correction is always signed by the person making it —
-- `marked_by` must be the caller, so the record of who changed an attendance
-- cannot be attributed to a colleague.
-- ---------------------------------------------------------------------------

alter table public.live_attendance_marks enable row level security;
alter table public.live_attendance_marks force row level security;

revoke all on public.live_attendance_marks from public, anon, authenticated;
grant select, insert, update, delete on public.live_attendance_marks to authenticated;

create policy live_attendance_marks_select_own on public.live_attendance_marks for select
  to authenticated using (user_id = auth.uid() or public.is_staff());

create policy live_attendance_marks_insert_staff on public.live_attendance_marks for insert
  to authenticated with check (public.is_staff() and marked_by = auth.uid());

create policy live_attendance_marks_update_staff on public.live_attendance_marks for update
  to authenticated using (public.is_staff())
  with check (public.is_staff() and marked_by = auth.uid());

create policy live_attendance_marks_delete_staff on public.live_attendance_marks for delete
  to authenticated using (public.is_staff());
