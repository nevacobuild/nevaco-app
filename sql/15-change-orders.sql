-- NEVACO Job Map: change orders (extra work) the customer approves online
-- A change order is a document with kind = 'change'. When the customer approves it, it is added to the contract value.

create or replace function public.doc_kind_name(k text) returns text language sql immutable as $$
  select case k when 'contract' then 'Contract' when 'change' then 'Change order' when 'invoice' then 'Invoice' else 'Estimate' end
$$;

create or replace function public.mark_doc_viewed(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.documents; v_day text := to_char(now() at time zone 'America/Toronto', 'YYYY-MM-DD');
begin
  select * into d from public.documents where length(coalesce(p_token,'')) >= 32 and share_token = p_token for update;
  if not found or d.status <> 'sent' or d.viewed_at is not null then return jsonb_build_object('first', false); end if;
  update public.documents set viewed_at = now() where id = d.id;
  update public.jobs set history = coalesce(history,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('d', v_day,
      't', public.doc_kind_name(d.kind) || ' ' || d.number || ' opened by the customer', 'by', 'Customer'))
  where id = d.job_id;
  return jsonb_build_object('first', true, 'kind', d.kind, 'number', d.number, 'job_id', d.job_id);
end $$;

create or replace function public.accept_shared_doc(p_token text, p_name text, p_signature text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.documents; v_day text := to_char(now() at time zone 'America/Toronto', 'YYYY-MM-DD'); v_kind text;
begin
  if length(coalesce(trim(p_name),'')) < 2 then raise exception 'Please type your full name'; end if;
  if coalesce(p_signature,'') not like 'data:image/png;base64,%' or length(p_signature) > 400000 then raise exception 'Please sign in the box'; end if;
  select * into d from public.documents where length(coalesce(p_token,'')) >= 32 and share_token = p_token for update;
  if not found then raise exception 'This link is not valid'; end if;
  v_kind := lower(public.doc_kind_name(d.kind));
  if d.kind = 'invoice' then raise exception 'This document does not need a signature'; end if;
  if d.status = 'accepted' then raise exception 'This % has already been signed', v_kind; end if;
  if d.status not in ('sent') then raise exception 'This % is not open for signing', v_kind; end if;
  if d.valid_until is not null and d.valid_until < (now() at time zone 'America/Toronto')::date then
    raise exception 'This % has expired. Please contact NEVACO BUILD for an updated one', v_kind; end if;
  update public.documents set status = 'accepted', accepted_at = now(), accepted_name = left(trim(p_name), 120), signature = p_signature where id = d.id;
  if d.kind = 'change' then
    -- extra work: only log it; the app adds approved change orders to the contract value
    update public.jobs set history = coalesce(history,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('d', v_day,
        't', 'Change order ' || d.number || ' approved online by ' || left(trim(p_name),120), 'by', 'Customer'))
    where id = d.job_id;
  else
    update public.jobs set
      value = d.subtotal, hst = d.hst,
      ms = coalesce(ms,'{}'::jsonb)
           || jsonb_build_object('estimate', coalesce(ms->'estimate', jsonb_build_object('done', true, 'date', v_day)))
           || jsonb_build_object('contract', jsonb_build_object('done', true, 'date', v_day)),
      follow = null,
      history = coalesce(history,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('d', v_day,
        't', public.doc_kind_name(d.kind) || ' ' || d.number || ' signed online by ' || left(trim(p_name),120), 'by', 'Customer'))
    where id = d.job_id;
  end if;
  return jsonb_build_object('ok', true, 'number', d.number, 'kind', d.kind, 'job_id', d.job_id, 'id', d.id);
end $$;

revoke all on function public.mark_doc_viewed(text) from public;
revoke all on function public.accept_shared_doc(text, text, text) from public;
grant execute on function public.mark_doc_viewed(text) to anon, authenticated, service_role;
grant execute on function public.accept_shared_doc(text, text, text) to anon, authenticated, service_role;

select 'Change orders ready' as result;
