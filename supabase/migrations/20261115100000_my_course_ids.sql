-- ---------------------------------------------------------------------------
-- The modules a student holds, asked of the database in one question.
--
-- "Mes formations" used to list the courses a student had already OPENED —
-- the `enrollments` bookmark, written on the first lesson visit. So somebody
-- who had just paid arrived on an empty list, with the module they bought
-- shown only as a line of text under "Mes accès".
--
-- What a student holds is not a list the application may work out for itself:
-- it is whatever `has_course_access` says — a module bought outright, a year
-- of a cursus, a site-wide grant, nothing overdue, all on the clock.
-- Re-deriving that in TypeScript would be a second copy of the paywall's rule,
-- free to drift from the first. This function asks the same gate about every
-- published course and returns the ones it opens, in one round trip.
--
-- It reveals nothing new: each id it returns is a course the caller can
-- already open, and the catalogue of published courses is public.
-- ---------------------------------------------------------------------------

create or replace function public.my_course_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id
    from public.courses c
   where c.status = 'published'
     and auth.uid() is not null
     and public.has_course_access(c.id, auth.uid());
$$;

-- A new function starts closed since the function-grants migration; this one
-- is for a signed-in student and for nobody else.
revoke all on function public.my_course_ids() from public, anon, authenticated;
grant execute on function public.my_course_ids() to authenticated, service_role;

comment on function public.my_course_ids() is
  'Published courses the caller may open, by the same has_course_access the lesson policies use.';
