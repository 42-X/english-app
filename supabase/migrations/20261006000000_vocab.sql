-- "My words": vocabulary the learner saved, synced like the other local-first tables.
create table public.vocab (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at bigint not null,
  deleted boolean not null default false,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index vocab_pull_idx on public.vocab (user_id, server_updated_at);
create trigger vocab_touch before insert or update on public.vocab
  for each row execute function public.touch_server_updated_at();
alter table public.vocab enable row level security;
create policy "own rows: select" on public.vocab for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows: insert" on public.vocab for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own rows: update" on public.vocab for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows: delete" on public.vocab for delete to authenticated using (user_id = (select auth.uid()));
