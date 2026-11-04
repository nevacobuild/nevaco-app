-- NEVACO Job Map: a private link per job so partners can add expenses + receipt photos without an app account
create table if not exists public.expense_links (
  token text primary key default replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''),
  job_id text not null references public.jobs(id) on delete cascade,
  active boolean not null default true,
  created_by text,
  created_at timestamptz default now(),
  last_used_at timestamptz
);
create index if not exists expense_links_job_idx on public.expense_links (job_id);
alter table public.expense_links enable row level security;
drop policy if exists "team manages expense links" on public.expense_links;
create policy "team manages expense links" on public.expense_links
  for all to authenticated using (public.is_team()) with check (public.is_team());
do $$ begin
  begin alter publication supabase_realtime add table public.expense_links; exception when duplicate_object then null; end;
end $$;

alter table public.job_expenses
  add column if not exists via_link boolean default false,
  add column if not exists submitted_by text default '';

-- is this a live link?
create or replace function public.expense_link_ok(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.expense_links l join public.jobs j on j.id = l.job_id
                 where length(coalesce(p_token,'')) >= 32 and l.token = p_token and l.active);
$$;

-- what the link page shows: the job, the contractor list, and what was already sent with this link
create or replace function public.get_expense_link(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'job', jsonb_build_object('name', j.name, 'address', j.address, 'city', j.city, 'type', j.type),
    'contractors', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'trade', c.trade) order by c.name) from public.contractors c), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('date', e.date, 'title', e.title, 'category', e.category, 'vendor', e.vendor,
                          'amount', e.amount, 'paid_by', e.paid_by, 'photos', jsonb_array_length(coalesce(e.photos,'[]'::jsonb))) order by e.created_at desc)
                        from (select * from public.job_expenses x where x.job_id = j.id and x.via_link order by x.created_at desc limit 30) e), '[]'::jsonb))
  from public.expense_links l join public.jobs j on j.id = l.job_id
  where length(coalesce(p_token,'')) >= 32 and l.token = p_token and l.active;
$$;

-- add one expense through the link
create or replace function public.submit_expense(p_token text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  l public.expense_links; v_id text := gen_random_uuid()::text; v_amt numeric; v_photos jsonb := '[]'::jsonb; p jsonb;
  v_by text := left(trim(coalesce(p_data->>'paid_by','')), 60); v_pm text := coalesce(p_data->>'pay_method','');
  v_sub text := nullif(p_data->>'contractor_id',''); v_date date; v_day text := to_char(now() at time zone 'America/Toronto', 'YYYY-MM-DD');
begin
  select * into l from public.expense_links where length(coalesce(p_token,'')) >= 32 and token = p_token and active;
  if not found then raise exception 'This link is not active anymore. Ask NEVACO BUILD for a new one.'; end if;
  begin v_amt := round((p_data->>'amount')::numeric, 2); exception when others then v_amt := null; end;
  if v_amt is null or v_amt <= 0 or v_amt > 1000000 then raise exception 'Enter the amount'; end if;
  if length(v_by) < 2 then raise exception 'Choose who paid'; end if;
  if v_pm not in ('bcredit','bdebit','bcash','personal') then raise exception 'Choose how it was paid'; end if;
  begin v_date := (p_data->>'date')::date; exception when others then v_date := null; end;
  if v_date is null or v_date > (now() at time zone 'America/Toronto')::date + 1 or v_date < date '2020-01-01' then v_date := (now() at time zone 'America/Toronto')::date; end if;
  if v_sub is not null and not exists (select 1 from public.contractors where id = v_sub) then v_sub := null; end if;
  if jsonb_typeof(p_data->'photos') = 'array' then
    if jsonb_array_length(p_data->'photos') > 12 then raise exception 'Up to 12 photos per expense'; end if;
    for p in select * from jsonb_array_elements(p_data->'photos') loop
      if coalesce(p->>'path','') like 'expense-links/' || p_token || '/%' then
        v_photos := v_photos || jsonb_build_array(jsonb_build_object('path', p->>'path', 'name', left(coalesce(p->>'name',''),120), 'size', coalesce((p->>'size')::bigint,0)));
      end if;
    end loop;
  end if;
  insert into public.job_expenses (id, job_id, date, title, category, amount, paid_by, notes, photos, vendor, contractor_id, pay_method, via_link, submitted_by, created_by)
  values (v_id, l.job_id, v_date, left(coalesce(p_data->>'title',''),120), left(coalesce(p_data->>'category','Other'),40), v_amt, v_by,
          left(coalesce(p_data->>'notes',''),1000), v_photos, left(coalesce(p_data->>'vendor',''),80), v_sub, v_pm, true, v_by, 'link');
  update public.expense_links set last_used_at = now() where token = p_token;
  update public.jobs set history = coalesce(history,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('d', v_day,
      't', 'Expense added by link: ' || coalesce(nullif(p_data->>'title',''), nullif(p_data->>'vendor',''), p_data->>'category', 'Expense') || ' $' || v_amt::text, 'by', v_by))
  where id = l.job_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

revoke all on function public.expense_link_ok(text) from public;
revoke all on function public.get_expense_link(text) from public;
revoke all on function public.submit_expense(text, jsonb) from public;
grant execute on function public.expense_link_ok(text) to anon, authenticated;
grant execute on function public.get_expense_link(text) to anon, authenticated;
grant execute on function public.submit_expense(text, jsonb) to anon, authenticated;

-- receipt photos from the link go to job-files/expense-links/<token>/… (upload only, nobody outside the team can read them)
drop policy if exists "expense link uploads" on storage.objects;
create policy "expense link uploads" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'job-files' and (storage.foldername(name))[1] = 'expense-links'
              and public.expense_link_ok((storage.foldername(name))[2])
              and lower(storage.extension(name)) in ('jpg','jpeg','png','webp','heic','heif'));

select 'Expense links ready' as result;
