-- NEVACO Job Map: estimates with online signing
create table if not exists public.documents (
  id text primary key default gen_random_uuid()::text,
  job_id text not null references public.jobs(id) on delete cascade,
  kind text not null default 'estimate',
  number text not null,
  status text not null default 'draft',
  date date not null default current_date,
  valid_until date,
  title text default '',
  items jsonb not null default '[]'::jsonb,
  lump numeric,
  hst boolean default true,
  deposit_pct numeric default 30,
  notes text default '',
  terms text default '',
  subtotal numeric default 0,
  tax numeric default 0,
  total numeric default 0,
  share_token text unique not null default replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''),
  sent_at timestamptz,
  accepted_at timestamptz,
  accepted_name text,
  signature text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists documents_job_idx on public.documents(job_id);
drop trigger if exists documents_touch on public.documents;
create trigger documents_touch before update on public.documents for each row execute function public.touch_updated_at();

alter table public.documents enable row level security;
drop policy if exists "team manages documents" on public.documents;
create policy "team manages documents" on public.documents
  for all to authenticated using (public.is_team()) with check (public.is_team());

do $$ begin
  begin alter publication supabase_realtime add table public.documents; exception when duplicate_object then null; end;
end $$;

-- Customer view: only the one document whose secret link was shared
create or replace function public.get_shared_doc(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'kind', d.kind, 'number', d.number, 'status', d.status, 'date', d.date, 'valid_until', d.valid_until,
    'title', d.title, 'items', d.items, 'lump', d.lump, 'hst', d.hst, 'deposit_pct', d.deposit_pct,
    'notes', d.notes, 'terms', d.terms, 'subtotal', d.subtotal, 'tax', d.tax, 'total', d.total,
    'accepted_at', d.accepted_at, 'accepted_name', d.accepted_name, 'signature', d.signature,
    'customer', jsonb_build_object('name', j.name, 'address', j.address, 'city', j.city, 'phone', j.phone, 'email', j.email))
  from public.documents d join public.jobs j on j.id = d.job_id
  where length(coalesce(p_token,'')) >= 32 and d.share_token = p_token;
$$;

-- Customer accepts and signs
create or replace function public.accept_shared_doc(p_token text, p_name text, p_signature text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.documents; v_day text := to_char(now() at time zone 'America/Toronto', 'YYYY-MM-DD');
begin
  if length(coalesce(trim(p_name),'')) < 2 then raise exception 'Please type your full name'; end if;
  if coalesce(p_signature,'') not like 'data:image/png;base64,%' or length(p_signature) > 400000 then raise exception 'Please sign in the box'; end if;
  select * into d from public.documents where length(coalesce(p_token,'')) >= 32 and share_token = p_token for update;
  if not found then raise exception 'This link is not valid'; end if;
  if d.status = 'accepted' then raise exception 'This estimate has already been accepted'; end if;
  if d.status not in ('sent') then raise exception 'This estimate is not open for signing'; end if;
  if d.valid_until is not null and d.valid_until < (now() at time zone 'America/Toronto')::date then raise exception 'This estimate has expired. Please contact NEVACO BUILD for an updated estimate'; end if;
  update public.documents set status = 'accepted', accepted_at = now(), accepted_name = left(trim(p_name), 120), signature = p_signature where id = d.id;
  update public.jobs set
    value = d.subtotal, hst = d.hst,
    ms = coalesce(ms,'{}'::jsonb)
         || jsonb_build_object('estimate', coalesce(ms->'estimate', jsonb_build_object('done', true, 'date', v_day)))
         || jsonb_build_object('contract', jsonb_build_object('done', true, 'date', v_day)),
    follow = null,
    history = coalesce(history,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('d', v_day,
      't', 'Estimate ' || d.number || ' accepted and signed online by ' || left(trim(p_name),120), 'by', 'Customer'))
  where id = d.job_id;
  return jsonb_build_object('ok', true, 'number', d.number);
end $$;

revoke all on function public.get_shared_doc(text) from public;
revoke all on function public.accept_shared_doc(text, text, text) from public;
grant execute on function public.get_shared_doc(text) to anon, authenticated;
grant execute on function public.accept_shared_doc(text, text, text) to anon, authenticated;

select 'Estimates ready' as result;
