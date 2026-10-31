-- NEVACO Job Map: Contractors tab (insurance, WSIB, license, payment details, documents)
alter table public.contractors
  add column if not exists company text default '',
  add column if not exists address text default '',
  add column if not exists hst text default '',
  add column if not exists wsib text default '',
  add column if not exists wsib_exp date,
  add column if not exists ins_company text default '',
  add column if not exists ins_policy text default '',
  add column if not exists ins_amount text default '',
  add column if not exists ins_exp date,
  add column if not exists license text default '',
  add column if not exists rate text default '',
  add column if not exists pay_method text default '';
-- Files can belong to a job or to a contractor (insurance certificate, WSIB clearance, void cheque)
alter table public.files alter column job_id drop not null;
alter table public.files add column if not exists contractor_id text references public.contractors(id) on delete cascade;
create index if not exists files_contractor_idx on public.files (contractor_id);
select 'Contractors ready' as result;
