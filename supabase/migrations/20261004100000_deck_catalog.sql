-- ---------------------------------------------------------------------------
-- A rendered deck, reused across classes
--
-- The school teaches the same module to several groups and uploads the same
-- PDF to each of them. Rendering it again in the browser and uploading four
-- hundred pages again is minutes of the teacher's life and a hundred megabytes
-- of her uplink, for bytes we already have.
--
-- So a rendered PDF is content-addressed: the browser hashes the file, the
-- pages are stored once under `decks/<sha256>/…`, and a second class attaches
-- the existing pages to its session by inserting `live_slides` rows. Nothing
-- is re-rendered and nothing is re-uploaded.
--
-- The catalogue is staff-only. Students never read it: they read their own
-- session's `live_slides` rows, which is the same policy as before.
-- ---------------------------------------------------------------------------

create table public.deck_catalog (
  fingerprint text primary key,
  page_count  integer not null,
  -- Ordered: [{ key, filename, mimeType, byteSize }], one entry per page.
  pages       jsonb not null,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint deck_catalog_fingerprint_shape check (fingerprint ~ '^[a-f0-9]{64}$'),
  constraint deck_catalog_pages_is_array check (jsonb_typeof(pages) = 'array'),
  constraint deck_catalog_page_count_sane check (page_count between 1 and 500)
);

alter table public.deck_catalog enable row level security;
alter table public.deck_catalog force row level security;

revoke all on public.deck_catalog from anon, authenticated;
grant select, insert, update, delete on public.deck_catalog to authenticated;

create policy deck_catalog_staff on public.deck_catalog for all
  to authenticated using (public.is_staff()) with check (public.is_staff());

-- ---------------------------------------------------------------------------
-- A slide may now point at a shared deck object
--
-- The key check admitted only `live/<session>/…`. It admits the deck prefix
-- too — the object is the same bytes for every class, and the row that names
-- it is still per session, which is what the policies read.
--
-- The UNIQUE on `storage_key` has to go for the same reason: two sessions
-- legitimately hold rows naming the same object. Uniqueness of the bytes is
-- the fingerprint's job now.
-- ---------------------------------------------------------------------------

alter table public.live_slides drop constraint if exists live_slides_key_owned;

alter table public.live_slides add constraint live_slides_key_owned check (
  storage_key ~ ('^live/' || session_id::text || '/[A-Za-z0-9_-]{8,64}\.(png|jpg|webp)$')
  or storage_key ~ '^decks/[a-f0-9]{64}/[A-Za-z0-9_-]{8,64}\.(png|jpg|webp)$'
);

alter table public.live_slides drop constraint if exists live_slides_storage_key_key;
