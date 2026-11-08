-- NEVACO Job Map: contracts with online signing (same documents table as estimates and invoices)
alter table public.documents add column if not exists extra jsonb not null default '{}'::jsonb;  -- contract details: customer, dates, payment schedule, warranty, permits
alter table public.documents add column if not exists owner_signature text;    -- NEVACO BUILD signature (data:image/png)
alter table public.documents add column if not exists owner_name text;
alter table public.documents add column if not exists owner_signed_at timestamptz;
alter table public.documents add column if not exists viewed_at timestamptz;   -- first time the customer opened the link
alter table public.documents add column if not exists sign_meta jsonb;         -- signing record: ip, device, time

-- Customer view: only the one document whose secret link was shared
create or replace function public.get_shared_doc(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'kind', d.kind, 'number', d.number, 'status', d.status, 'date', d.date, 'valid_until', d.valid_until,
    'title', d.title, 'items', d.items, 'lump', d.lump, 'hst', d.hst, 'deposit_pct', d.deposit_pct,
    'notes', d.notes, 'terms', d.terms, 'subtotal', d.subtotal, 'tax', d.tax, 'total', d.total,
    'credit', d.credit, 'due_date', d.due_date, 'paid_at', d.paid_at, 'paid_method', d.paid_method, 'ref', d.ref,
    'accepted_at', d.accepted_at, 'accepted_name', d.accepted_name, 'signature', d.signature,
    'extra', coalesce(d.extra, '{}'::jsonb) - 'customer',
    'owner_signature', d.owner_signature, 'owner_name', d.owner_name, 'owner_signed_at', d.owner_signed_at,
    'sign_meta', d.sign_meta,
    'customer', jsonb_build_object(
      'name', coalesce(nullif(d.extra->'customer'->>'name',''), j.name),
      'address', coalesce(nullif(d.extra->'customer'->>'address',''), j.address),
      'city', coalesce(nullif(d.extra->'customer'->>'city',''), j.city),
      'postal', coalesce(nullif(d.extra->'customer'->>'postal',''), j.postal),
      'phone', coalesce(nullif(d.extra->'customer'->>'phone',''), j.phone),
      'email', coalesce(nullif(d.extra->'customer'->>'email',''), j.email)))
  from public.documents d join public.jobs j on j.id = d.job_id
  where length(coalesce(p_token,'')) >= 32 and d.share_token = p_token;
$$;

-- Customer opened the link (first time only)
create or replace function public.mark_doc_viewed(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.documents; v_day text := to_char(now() at time zone 'America/Toronto', 'YYYY-MM-DD');
begin
  select * into d from public.documents where length(coalesce(p_token,'')) >= 32 and share_token = p_token for update;
  if not found or d.status <> 'sent' or d.viewed_at is not null then return jsonb_build_object('first', false); end if;
  update public.documents set viewed_at = now() where id = d.id;
  update public.jobs set history = coalesce(history,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('d', v_day,
      't', initcap(d.kind) || ' ' || d.number || ' opened by the customer', 'by', 'Customer'))
  where id = d.job_id;
  return jsonb_build_object('first', true, 'kind', d.kind, 'number', d.number, 'job_id', d.job_id);
end $$;

-- Customer signs (estimate or contract)
create or replace function public.accept_shared_doc(p_token text, p_name text, p_signature text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.documents; v_day text := to_char(now() at time zone 'America/Toronto', 'YYYY-MM-DD'); v_kind text;
begin
  if length(coalesce(trim(p_name),'')) < 2 then raise exception 'Please type your full name'; end if;
  if coalesce(p_signature,'') not like 'data:image/png;base64,%' or length(p_signature) > 400000 then raise exception 'Please sign in the box'; end if;
  select * into d from public.documents where length(coalesce(p_token,'')) >= 32 and share_token = p_token for update;
  if not found then raise exception 'This link is not valid'; end if;
  v_kind := case when d.kind = 'contract' then 'contract' else 'estimate' end;
  if d.kind = 'invoice' then raise exception 'This document does not need a signature'; end if;
  if d.status = 'accepted' then raise exception 'This % has already been signed', v_kind; end if;
  if d.status not in ('sent') then raise exception 'This % is not open for signing', v_kind; end if;
  if d.valid_until is not null and d.valid_until < (now() at time zone 'America/Toronto')::date then
    raise exception 'This % has expired. Please contact NEVACO BUILD for an updated one', v_kind; end if;
  update public.documents set status = 'accepted', accepted_at = now(), accepted_name = left(trim(p_name), 120), signature = p_signature where id = d.id;
  update public.jobs set
    value = d.subtotal, hst = d.hst,
    ms = coalesce(ms,'{}'::jsonb)
         || jsonb_build_object('estimate', coalesce(ms->'estimate', jsonb_build_object('done', true, 'date', v_day)))
         || jsonb_build_object('contract', jsonb_build_object('done', true, 'date', v_day)),
    follow = null,
    history = coalesce(history,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('d', v_day,
      't', initcap(v_kind) || ' ' || d.number || ' signed online by ' || left(trim(p_name),120), 'by', 'Customer'))
  where id = d.job_id;
  return jsonb_build_object('ok', true, 'number', d.number, 'kind', d.kind, 'job_id', d.job_id, 'id', d.id);
end $$;

revoke all on function public.get_shared_doc(text) from public;
revoke all on function public.mark_doc_viewed(text) from public;
revoke all on function public.accept_shared_doc(text, text, text) from public;
grant execute on function public.get_shared_doc(text) to anon, authenticated, service_role;
grant execute on function public.mark_doc_viewed(text) to anon, authenticated, service_role;
grant execute on function public.accept_shared_doc(text, text, text) to anon, authenticated, service_role;

-- NEVACO signature and contract defaults (one place for all devices)
insert into public.app_settings (key, value) values ('contract', '{}'::jsonb) on conflict (key) do nothing;

select 'Contracts ready' as result;
