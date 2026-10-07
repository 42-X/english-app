-- Coaching: a learner shares read-only access to their practice with a coach (by the coach's
-- account email), and the coach can leave notes that appear on the learner's Home screen.

create table public.coach_links (
  learner_id uuid not null default auth.uid() references auth.users on delete cascade,
  learner_email text not null default (auth.jwt() ->> 'email'),
  learner_name text,
  coach_email text not null check (coach_email = lower(trim(coach_email)) and coach_email like '%@%'),
  created_at timestamptz not null default now(),
  primary key (learner_id, coach_email)
);
alter table public.coach_links enable row level security;
create policy "learner: select" on public.coach_links for select to authenticated using (learner_id = (select auth.uid()));
create policy "learner: insert" on public.coach_links for insert to authenticated
  with check (learner_id = (select auth.uid()) and learner_email = (select auth.jwt() ->> 'email'));
create policy "learner: update" on public.coach_links for update to authenticated
  using (learner_id = (select auth.uid())) with check (learner_id = (select auth.uid()));
create policy "learner: delete" on public.coach_links for delete to authenticated using (learner_id = (select auth.uid()));
create policy "coach: select" on public.coach_links for select to authenticated
  using (coach_email = lower((select auth.jwt() ->> 'email')));

-- True when the signed-in user is a coach of `learner`. Security definer so table policies can use it.
create or replace function public.is_coach_of(learner uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.coach_links l
    where l.learner_id = learner and l.coach_email = lower(auth.jwt() ->> 'email')
  )
$$;
revoke execute on function public.is_coach_of(uuid) from public, anon;
grant execute on function public.is_coach_of(uuid) to authenticated;

-- Coaches can read (never write) their learners' practice data.
do $$
declare t text;
begin
  foreach t in array array['attempts', 'mistakes', 'plans', 'vocab', 'listening_attempts', 'settings'] loop
    execute format('create policy "coach: select" on public.%I for select to authenticated using (public.is_coach_of(user_id))', t);
  end loop;
end $$;

create table public.coach_notes (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references auth.users on delete cascade,
  coach_email text not null default lower(auth.jwt() ->> 'email'),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index coach_notes_learner_idx on public.coach_notes (learner_id, created_at desc);
alter table public.coach_notes enable row level security;
create policy "coach: select" on public.coach_notes for select to authenticated
  using (coach_email = lower((select auth.jwt() ->> 'email')));
create policy "coach: insert" on public.coach_notes for insert to authenticated
  with check (coach_email = lower((select auth.jwt() ->> 'email')) and public.is_coach_of(learner_id));
create policy "coach: delete" on public.coach_notes for delete to authenticated
  using (coach_email = lower((select auth.jwt() ->> 'email')));
create policy "learner: select" on public.coach_notes for select to authenticated using (learner_id = (select auth.uid()));
create policy "learner: mark read" on public.coach_notes for update to authenticated
  using (learner_id = (select auth.uid())) with check (learner_id = (select auth.uid()));
-- The learner may only set read_at, never edit the note itself.
revoke update on public.coach_notes from authenticated;
grant update (read_at) on public.coach_notes to authenticated;
