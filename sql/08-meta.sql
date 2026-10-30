-- NEVACO Job Map: Facebook & Instagram lead forms (Meta Lead Ads)
create table if not exists public.meta_pages (
  page_id text primary key,
  name text,
  token text,
  connected_at timestamptz default now(),
  last_lead_at timestamptz,
  last_sync_at timestamptz,
  last_error text
);
alter table public.meta_pages enable row level security;   -- no policies: only the server function reads page tokens
alter table public.private_config add column if not exists meta_verify text;
select 'Facebook leads ready' as result;
