-- NEVACO Job Map: Leads (emails on each lead, HomeStars, opportunities) and push notifications

-- 1. Emails can belong to a lead/customer job as well as to a partner
alter table public.partner_messages alter column partner_id drop not null;
alter table public.partner_messages add column if not exists job_id text references public.jobs(id) on delete cascade;
create index if not exists pmsg_job_idx on public.partner_messages (job_id, at);

-- 2. Outside reference for leads (e.g. HS-2206934 = HomeStars job number)
alter table public.jobs add column if not exists ext_ref text;
create unique index if not exists jobs_ext_ref_uq on public.jobs (ext_ref) where ext_ref is not null;

-- 3. Opportunities: HomeStars leads in your area and invites you have not taken yet
create table if not exists public.opportunities (
  id text primary key default gen_random_uuid()::text,
  source text default 'HomeStars',
  kind text default 'area',            -- area, invite
  title text default '',
  customer text default '',
  city text default '',
  postal text default '',
  km numeric,
  hired_before boolean default false,
  url text default '',
  gmail_id text unique,
  status text default 'new',           -- new, dismissed, taken
  at timestamptz default now()
);
create index if not exists opp_at_idx on public.opportunities (at desc);
alter table public.opportunities enable row level security;
drop policy if exists "team manages opportunities" on public.opportunities;
create policy "team manages opportunities" on public.opportunities
  for all to authenticated using (public.is_team()) with check (public.is_team());

-- 4. Push notifications (iPhone, iPad, Mac)
create table if not exists public.push_subs (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  email text,
  device text default '',
  created_at timestamptz default now(),
  last_ok timestamptz
);
alter table public.push_subs enable row level security;
drop policy if exists "team manages own push" on public.push_subs;
create policy "team manages own push" on public.push_subs
  for all to authenticated using (public.is_team()) with check (public.is_team());
create table if not exists public.notify_state (key text primary key, at timestamptz default now());
alter table public.notify_state enable row level security;
alter table public.private_config add column if not exists vapid_public text;
alter table public.private_config add column if not exists vapid_private text;

-- 5. Live updates
do $$ begin
  begin alter publication supabase_realtime add table public.opportunities; exception when duplicate_object then null; end;
end $$;

-- 6. New lead from the website, HomeStars or ads: send a push right away
create or replace function public.notify_new_lead() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(new.updated_by, '') not like '%@%' then
    perform net.http_post(
      url := 'https://pnomirvkekhurtuigxol.supabase.co/functions/v1/gmail',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-cron-secret', (select cron_secret from public.private_config where id = 1)),
      body := jsonb_build_object('action', 'notify_job', 'id', new.id),
      timeout_milliseconds := 20000);
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists jobs_notify_new on public.jobs;
create trigger jobs_notify_new after insert on public.jobs
  for each row execute function public.notify_new_lead();

-- 7. Reminders for leads waiting on you: checked every hour (sent only 8 AM to 8 PM Toronto time)
do $$ begin perform cron.unschedule('lead-reminders'); exception when others then null; end $$;
select cron.schedule('lead-reminders', '5 * * * *', $cron$
  select net.http_post(
    url := 'https://pnomirvkekhurtuigxol.supabase.co/functions/v1/gmail',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select cron_secret from public.private_config where id = 1)),
    body := '{"action":"remind"}'::jsonb,
    timeout_milliseconds := 30000);
$cron$);

select 'Leads ready' as result;
