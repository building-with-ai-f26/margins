-- Margins database setup (Supabase). Reference copy of what was run in the Supabase SQL editor for Build 3.
-- Every saved item (drafts, Glossary, history, reports, working copy) is one row in `docs`, owned by one account.

create table if not exists public.docs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  path text not null check (char_length(path) between 1 and 300),
  data jsonb not null check (pg_column_size(data) < 500000),
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

-- Row-level security: a signed-in person can only see, add, change or delete their own rows.
alter table public.docs enable row level security;
create policy "read own docs"   on public.docs for select to authenticated using ((select auth.uid()) = user_id);
create policy "add own docs"    on public.docs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "change own docs" on public.docs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "delete own docs" on public.docs for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.docs from anon;
grant select, insert, update, delete on public.docs to authenticated;

-- AI usage: one row per person per day. Nobody can read or change it directly; only use_ai_call() touches it.
create table if not exists public.ai_usage (
  user_id uuid primary key references auth.users (id) on delete cascade,
  day date not null default current_date,
  calls int not null default 0
);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;

-- Counts one AI request for the signed-in person and returns today's total. Refuses signed-out callers.
create or replace function public.use_ai_call() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into ai_usage (user_id, day, calls) values (auth.uid(), current_date, 1)
  on conflict (user_id) do update
    set calls = case when ai_usage.day = current_date then ai_usage.calls + 1 else 1 end,
        day = current_date
  returning calls into n;
  return n;
end $$;
revoke all on function public.use_ai_call() from public, anon;
grant execute on function public.use_ai_call() to authenticated;
