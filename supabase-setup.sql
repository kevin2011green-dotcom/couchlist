-- Couchlist database setup. Paste into Supabase: SQL Editor > New query > Run.

-- One row per show or movie on someone's list.
create table if not exists public.titles (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name           text not null,
  media_type     text not null default 'tv' check (media_type in ('tv', 'movie')),
  status         text not null default 'plan' check (status in ('watching', 'plan', 'finished')),
  service        text,
  notes          text,
  recommended_by text,
  tmdb_id        integer,
  year           integer,
  poster_path    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists titles_user_idx on public.titles (user_id, updated_at desc);

-- Each person can only see and change their own rows.
alter table public.titles enable row level security;

drop policy if exists "own titles" on public.titles;
create policy "own titles" on public.titles
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Small key/value store for app settings, readable only by signed-in users.
-- Holds the TMDB token so it isn't published in the public GitHub repo.
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);

alter table public.app_config enable row level security;

drop policy if exists "signed-in users read config" on public.app_config;
create policy "signed-in users read config" on public.app_config
  for select to authenticated
  using (true);

-- Then run this once, with your TMDB "API Read Access Token" pasted in:
-- insert into public.app_config (key, value) values ('tmdb_token', 'PASTE-TOKEN-HERE')
--   on conflict (key) do update set value = excluded.value;
