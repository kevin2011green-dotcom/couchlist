-- Couchlist: categories (Holiday, Feel-good, Mystery...). Run once in Supabase: SQL Editor > New query > Run.
-- Safe to re-run.

alter table public.titles
  add column if not exists categories text[] not null default '{}';
