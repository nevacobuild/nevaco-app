-- NEVACO Job Map: Job plan (tasks with dates, contractors and what we pay them)
create table if not exists public.contractors (
  id text primary key default gen_random_uuid()::text,
  name text not null default '',
  trade text default '',
  phone text default '',
  email text default '',
  notes text default '',
  created_at timestamptz default now()
);
create table if not exists public.job_tasks (
  id text primary key default gen_random_uuid()::text,
  job_id text not null references public.jobs(id) on delete cascade,
  title text not null default '',
  start date,
  "end" date,
  contractor_id text references public.contractors(id) on delete set null,
  cost numeric,
  paid boolean default false,
  paid_at date,
  done boolean default false,
  notes text default '',
  sort int default 0,
  created_at timestamptz default now()
);
create index if not exists job_tasks_job_idx on public.job_tasks (job_id, sort);
create index if not exists job_tasks_dates_idx on public.job_tasks (start, "end");
alter table public.contractors enable row level security;
alter table public.job_tasks enable row level security;
drop policy if exists "team manages contractors" on public.contractors;
create policy "team manages contractors" on public.contractors
  for all to authenticated using (public.is_team()) with check (public.is_team());
drop policy if exists "team manages job tasks" on public.job_tasks;
create policy "team manages job tasks" on public.job_tasks
  for all to authenticated using (public.is_team()) with check (public.is_team());
do $$ begin
  begin alter publication supabase_realtime add table public.job_tasks; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.contractors; exception when duplicate_object then null; end;
end $$;
-- Hani is our painting subcontractor
insert into public.contractors (id, name, trade) values ('hani-hatina', 'Hani Hatina (Hatina Painting)', 'Painting')
on conflict (id) do nothing;
select 'Job plan ready' as result;
