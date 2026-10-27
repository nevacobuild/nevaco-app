-- NEVACO Job Map: Partners (realtors and property managers) with Gmail conversations

-- 1. Partners
create table if not exists public.partners (
  id text primary key default gen_random_uuid()::text,
  name text not null default '',
  company text default '',
  type text default 're',            -- re = realtor, pm = property manager, other
  email text default '',
  phone text default '',
  area text default '',
  status text default 'sent',        -- sent, replied, meeting, partner, cold
  meet date,
  meet_time text default '',
  follow date,
  notes text default '',
  source text default 'app',         -- app or gmail
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by text
);
create index if not exists partners_email_idx on public.partners (lower(email));
drop trigger if exists partners_touch on public.partners;
create trigger partners_touch before update on public.partners
  for each row execute function public.touch_updated_at();

-- 2. Messages (emails in and out, plus notes)
create table if not exists public.partner_messages (
  id text primary key default gen_random_uuid()::text,
  partner_id text not null references public.partners(id) on delete cascade,
  dir text not null default 'note',  -- in, out, note
  gmail_id text unique,
  thread_id text,
  rfc_id text,
  subject text default '',
  body text default '',
  from_email text default '',
  to_email text default '',
  attachments jsonb not null default '[]'::jsonb,
  unread boolean not null default false,
  at timestamptz not null default now(),
  created_by text
);
create index if not exists pmsg_partner_idx on public.partner_messages (partner_id, at);
create index if not exists pmsg_thread_idx on public.partner_messages (thread_id);

-- 3. Referrals: a job can be referred by a partner
alter table public.jobs add column if not exists partner_id text references public.partners(id) on delete set null;
alter table public.jobs add column if not exists ref_fee numeric;
alter table public.jobs add column if not exists ref_paid boolean default false;

-- 4. App settings (outreach search, signature, partnership PDF)
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);
insert into public.app_settings (key, value) values
  ('partners', jsonb_build_object(
     'outreach_query', '(subject:(partner OR partnership OR referral) OR filename:(partner OR partnership OR referral OR brochure))',
     'import_days', 90,
     'from_name', 'Kevin | NEVACO BUILD',
     'signature', E'Kevin\nNEVACO BUILD\n437-432-2252 · nevacobuild.ca',
     'pdf_path', '', 'pdf_name', ''))
on conflict (key) do nothing;

-- 5. Gmail connection: private, only the server function can read it
create table if not exists public.gmail_account (
  id int primary key default 1 check (id = 1),
  email text,
  refresh_token text,
  access_token text,
  expires_at timestamptz,
  label_id text,
  connected_at timestamptz default now(),
  last_sync_at timestamptz,
  sync_started_at timestamptz,
  last_error text
);
create table if not exists public.gmail_oauth_states (
  state text primary key,
  email text,
  created_at timestamptz default now()
);
create table if not exists public.private_config (
  id int primary key default 1 check (id = 1),
  cron_secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
insert into public.private_config (id) values (1) on conflict (id) do nothing;

-- 6. Security: team only; Gmail tokens and secrets never reach the app
alter table public.partners enable row level security;
alter table public.partner_messages enable row level security;
alter table public.app_settings enable row level security;
alter table public.gmail_account enable row level security;
alter table public.gmail_oauth_states enable row level security;
alter table public.private_config enable row level security;
drop policy if exists "team manages partners" on public.partners;
create policy "team manages partners" on public.partners
  for all to authenticated using (public.is_team()) with check (public.is_team());
drop policy if exists "team manages partner messages" on public.partner_messages;
create policy "team manages partner messages" on public.partner_messages
  for all to authenticated using (public.is_team()) with check (public.is_team());
drop policy if exists "team manages settings" on public.app_settings;
create policy "team manages settings" on public.app_settings
  for all to authenticated using (public.is_team()) with check (public.is_team());

-- Connection status for the app (no tokens)
create or replace function public.gmail_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not public.is_team() then null else coalesce((
    select jsonb_build_object('connected', refresh_token is not null, 'email', email,
      'connected_at', connected_at, 'last_sync_at', last_sync_at, 'last_error', last_error)
    from public.gmail_account where id = 1), jsonb_build_object('connected', false)) end;
$$;
revoke all on function public.gmail_status() from public;
grant execute on function public.gmail_status() to authenticated;

-- 7. Live updates
do $$ begin
  begin alter publication supabase_realtime add table public.partners; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.partner_messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.app_settings; exception when duplicate_object then null; end;
end $$;

-- 8. Check Gmail for new replies every 2 minutes
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
do $$ begin perform cron.unschedule('gmail-sync'); exception when others then null; end $$;
select cron.schedule('gmail-sync', '*/2 * * * *', $cron$
  select net.http_post(
    url := 'https://pnomirvkekhurtuigxol.supabase.co/functions/v1/gmail',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select cron_secret from public.private_config where id = 1)),
    body := '{"action":"sync","source":"cron"}'::jsonb,
    timeout_milliseconds := 60000)
  where exists (select 1 from public.gmail_account where id = 1 and refresh_token is not null);
$cron$);

select 'Partners ready' as result;
