-- NEVACO Job Map: invoices (uses the same documents table as estimates)
alter table public.documents add column if not exists credit numeric default 0;
alter table public.documents add column if not exists due_date date;
alter table public.documents add column if not exists paid_at timestamptz;
alter table public.documents add column if not exists paid_method text;
alter table public.documents add column if not exists ref text;

create or replace function public.get_shared_doc(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'kind', d.kind, 'number', d.number, 'status', d.status, 'date', d.date, 'valid_until', d.valid_until,
    'title', d.title, 'items', d.items, 'lump', d.lump, 'hst', d.hst, 'deposit_pct', d.deposit_pct,
    'notes', d.notes, 'terms', d.terms, 'subtotal', d.subtotal, 'tax', d.tax, 'total', d.total,
    'credit', d.credit, 'due_date', d.due_date, 'paid_at', d.paid_at, 'paid_method', d.paid_method, 'ref', d.ref,
    'accepted_at', d.accepted_at, 'accepted_name', d.accepted_name, 'signature', d.signature,
    'customer', jsonb_build_object('name', j.name, 'address', j.address, 'city', j.city, 'phone', j.phone, 'email', j.email))
  from public.documents d join public.jobs j on j.id = d.job_id
  where length(coalesce(p_token,'')) >= 32 and d.share_token = p_token;
$$;
revoke all on function public.get_shared_doc(text) from public;
grant execute on function public.get_shared_doc(text) to anon, authenticated;

select 'Invoices ready' as result;
