-- Fretline setup (v0.3): run once in Supabase → SQL Editor → New query → Run.
-- Safe to run again. Uses the same Supabase project as Groov; Fretline's
-- tables all start with fretline_ and don't touch Groov's.
--
-- What's stored, per account, visible only to that account:
--   fretline_lessons    your lessons (title, channel, chapters, where you stopped)
--   fretline_tab_fixes  the tab notes you fixed or added, per lesson
--   fretline_settings   your own tunings and which tuning each song uses
-- Recordings never leave the phone.

create table if not exists public.fretline_lessons (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  video_id text not null check (char_length(video_id) between 1 and 20),
  title text not null default '' check (char_length(title) <= 300),
  uploader text not null default '' check (char_length(uploader) <= 200),
  duration_sec integer not null default 0,
  thumbnail text,
  chapters jsonb not null default '[]'::jsonb,
  position_sec real not null default 0,
  added_at timestamptz not null default now(),
  opened_at timestamptz not null default now(),
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

create table if not exists public.fretline_tab_fixes (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  video_id text not null check (char_length(video_id) between 1 and 20),
  fixes jsonb not null default '{}'::jsonb check (pg_column_size(fixes) < 500000),
  updated_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

create table if not exists public.fretline_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 200000),
  updated_at timestamptz not null default now()
);

alter table public.fretline_lessons enable row level security;
alter table public.fretline_tab_fixes enable row level security;
alter table public.fretline_settings enable row level security;

-- Each table: you can only see and change your own rows.
do $$
declare t text;
begin
  foreach t in array array['fretline_lessons', 'fretline_tab_fixes', 'fretline_settings'] loop
    execute format('drop policy if exists "own rows: read" on public.%I', t);
    execute format('drop policy if exists "own rows: add" on public.%I', t);
    execute format('drop policy if exists "own rows: change" on public.%I', t);
    execute format('drop policy if exists "own rows: delete" on public.%I', t);
    execute format('create policy "own rows: read" on public.%I for select to authenticated using (user_id = auth.uid())', t);
    execute format('create policy "own rows: add" on public.%I for insert to authenticated with check (user_id = auth.uid())', t);
    execute format('create policy "own rows: change" on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('create policy "own rows: delete" on public.%I for delete to authenticated using (user_id = auth.uid())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
