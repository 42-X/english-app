-- HIW Trainer: local-first sync storage.
--
-- The app is local-first (IndexedDB). Each synced table stores the client document
-- as jsonb, keyed by (user_id, id). Conflict resolution is last-write-wins on the
-- client's updated_at; server_updated_at is the pull cursor.
-- The exercise library itself ships with the app as static JSON, so it needs no table.

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create or replace function public.touch_server_updated_at()
returns trigger language plpgsql as $$
begin
  new.server_updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['attempts', 'mistakes', 'plans', 'custom_exercises', 'settings'] loop
    execute format($f$
      create table public.%1$I (
        user_id uuid not null default auth.uid() references auth.users on delete cascade,
        id text not null,
        data jsonb not null,
        updated_at bigint not null,
        deleted boolean not null default false,
        server_updated_at timestamptz not null default now(),
        primary key (user_id, id)
      );
      create index %1$I_pull_idx on public.%1$I (user_id, server_updated_at);
      create trigger %1$I_touch before insert or update on public.%1$I
        for each row execute function public.touch_server_updated_at();
      alter table public.%1$I enable row level security;
      create policy "own rows: select" on public.%1$I for select to authenticated using (user_id = (select auth.uid()));
      create policy "own rows: insert" on public.%1$I for insert to authenticated with check (user_id = (select auth.uid()));
      create policy "own rows: update" on public.%1$I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
      create policy "own rows: delete" on public.%1$I for delete to authenticated using (user_id = (select auth.uid()));
    $f$, t);
  end loop;
end $$;

alter table public.profiles enable row level security;
create policy "own profile: select" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile: update" on public.profiles for update to authenticated using (id = (select auth.uid()));

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
