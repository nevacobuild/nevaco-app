-- NEVACO Job Map: file attachments (contracts, photos, permits) stored privately
insert into storage.buckets (id, name, public, file_size_limit)
values ('job-files', 'job-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "nevaco team reads job files" on storage.objects;
drop policy if exists "nevaco team uploads job files" on storage.objects;
drop policy if exists "nevaco team updates job files" on storage.objects;
drop policy if exists "nevaco team deletes job files" on storage.objects;
create policy "nevaco team reads job files" on storage.objects for select to authenticated
  using (bucket_id = 'job-files' and public.is_team());
create policy "nevaco team uploads job files" on storage.objects for insert to authenticated
  with check (bucket_id = 'job-files' and public.is_team());
create policy "nevaco team updates job files" on storage.objects for update to authenticated
  using (bucket_id = 'job-files' and public.is_team()) with check (bucket_id = 'job-files' and public.is_team());
create policy "nevaco team deletes job files" on storage.objects for delete to authenticated
  using (bucket_id = 'job-files' and public.is_team());

create table if not exists public.files (
  id text primary key default gen_random_uuid()::text,
  job_id text not null references public.jobs(id) on delete cascade,
  name text not null,
  path text not null,
  size bigint default 0,
  mime text default '',
  label text default '',
  created_at timestamptz default now(),
  uploaded_by text
);
create index if not exists files_job_idx on public.files(job_id);
alter table public.files enable row level security;
drop policy if exists "team manages files" on public.files;
create policy "team manages files" on public.files
  for all to authenticated using (public.is_team()) with check (public.is_team());
do $$ begin
  begin alter publication supabase_realtime add table public.files; exception when duplicate_object then null; end;
end $$;

select 'Files ready' as result;
