-- NEVACO Job Map: job expenses with receipt photos, store / contractor, who paid and how (safe to run more than once)
create table if not exists public.job_expenses (
  id text primary key default gen_random_uuid()::text,
  job_id text not null references public.jobs(id) on delete cascade,
  date date not null default current_date,
  title text not null default '',
  category text default '',
  amount numeric not null default 0,
  paid_by text default '',
  notes text default '',
  photos jsonb not null default '[]'::jsonb,   -- [{path, name, size}] in the private job-files bucket
  created_by text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists job_expenses_job_idx on public.job_expenses (job_id, date);
drop trigger if exists job_expenses_touch on public.job_expenses;
create trigger job_expenses_touch before update on public.job_expenses for each row execute function public.touch_updated_at();
alter table public.job_expenses enable row level security;
drop policy if exists "team manages job expenses" on public.job_expenses;
create policy "team manages job expenses" on public.job_expenses
  for all to authenticated using (public.is_team()) with check (public.is_team());
do $$ begin
  begin alter publication supabase_realtime add table public.job_expenses; exception when duplicate_object then null; end;
end $$;
-- Who and how: store for materials, contractor for subcontractor costs, payment method
alter table public.job_expenses
  add column if not exists vendor text default '',
  add column if not exists contractor_id text references public.contractors(id) on delete set null,
  add column if not exists pay_method text default '';
select 'Expenses ready' as result;
