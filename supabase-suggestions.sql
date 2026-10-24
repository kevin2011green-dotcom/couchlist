-- Couchlist: "Suggest to a friend". Run once in Supabase: SQL Editor > New query > Run.
-- Safe to re-run.

-- Each person's display name, shown to friends on suggestions ("from Kevin").
create table if not exists public.profiles (
  id           uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 40)
);

alter table public.profiles enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- A suggestion waiting in someone's inbox. It is deleted once they add it or say no thanks.
create table if not exists public.suggestions (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  sender_name  text not null,
  name         text not null,
  media_type   text not null default 'tv' check (media_type in ('tv', 'movie')),
  tmdb_id      integer,
  year         integer,
  poster_path  text,
  service      text,
  message      text check (char_length(message) <= 500),
  created_at   timestamptz not null default now()
);

create index if not exists suggestions_recipient_idx on public.suggestions (recipient_id, created_at desc);

-- Recipients can see and remove suggestions sent to them. There is no insert policy:
-- suggestions can only be created through send_suggestion() below.
alter table public.suggestions enable row level security;

drop policy if exists "recipient reads" on public.suggestions;
create policy "recipient reads" on public.suggestions
  for select to authenticated
  using (recipient_id = auth.uid());

drop policy if exists "recipient removes" on public.suggestions;
create policy "recipient removes" on public.suggestions
  for delete to authenticated
  using (recipient_id = auth.uid());

-- Sends a suggestion to the account with this email. Runs with elevated rights so it can
-- look the email up, but only ever reveals whether an account exists, never anything about it.
create or replace function public.send_suggestion(
  recipient_email text,
  p_name          text,
  p_media_type    text,
  p_tmdb_id       integer,
  p_year          integer,
  p_poster_path   text,
  p_service       text,
  p_message       text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid   uuid;
  sname text;
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.';
  end if;

  select id into rid from auth.users where lower(email) = lower(trim(recipient_email));
  if rid is null then
    raise exception 'No Couchlist account uses that email yet.';
  end if;
  if rid = auth.uid() then
    raise exception 'That''s your own email.';
  end if;

  select nullif(trim(display_name), '') into sname from public.profiles where id = auth.uid();
  if sname is null then
    select split_part(email, '@', 1) into sname from auth.users where id = auth.uid();
  end if;

  insert into public.suggestions
    (sender_id, recipient_id, sender_name, name, media_type, tmdb_id, year, poster_path, service, message)
  values
    (auth.uid(), rid, sname, p_name, coalesce(p_media_type, 'tv'), p_tmdb_id, p_year, p_poster_path,
     nullif(trim(p_service), ''), nullif(trim(p_message), ''));
end;
$$;

revoke execute on function public.send_suggestion(text, text, text, integer, integer, text, text, text) from public, anon;
grant execute on function public.send_suggestion(text, text, text, integer, integer, text, text, text) to authenticated;
