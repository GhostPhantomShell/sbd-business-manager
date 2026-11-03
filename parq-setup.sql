-- SBD Business Manager · PAR-Q+ setup
-- Paste this whole script into Supabase → SQL Editor → New query, then click Run.
-- Safe to run more than once. It does not touch any existing data.

-- 1) The PAR-Q+ table ---------------------------------------------------------
create table if not exists public.parq_forms (
  id              text primary key,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id       text not null,
  status          text not null default 'draft' check (status in ('draft','signed')),
  form_version    text not null default 'PAR-Q+ 2025 · 01-11-2024',
  data            jsonb not null default '{}'::jsonb,   -- answers, name, date, signature info
  completed_on    date,
  signed_at       timestamptz,
  expires_on      date,
  needs_clearance boolean not null default false,
  clearance       jsonb,                                -- coach's doctor-clearance note (kept outside the signed form)
  pdf_path        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists parq_forms_user_client on public.parq_forms (user_id, client_id);

-- 2) Privacy: only your own account can see or change your forms --------------
alter table public.parq_forms enable row level security;
drop policy if exists "Owner can read PAR-Q"   on public.parq_forms;
drop policy if exists "Owner can add PAR-Q"    on public.parq_forms;
drop policy if exists "Owner can change PAR-Q" on public.parq_forms;
drop policy if exists "Owner can delete PAR-Q" on public.parq_forms;
create policy "Owner can read PAR-Q"   on public.parq_forms for select to authenticated using (user_id = (select auth.uid()));
create policy "Owner can add PAR-Q"    on public.parq_forms for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Owner can change PAR-Q" on public.parq_forms for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Owner can delete PAR-Q" on public.parq_forms for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.parq_forms from anon;
grant select, insert, update, delete on public.parq_forms to authenticated;

-- 3) Lock: once signed, the form can never be edited or deleted -----------------
--    (only the coach's clearance note can change, and the PDF can be attached once)
create or replace function public.parq_lock() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'signed' then raise exception 'This PAR-Q+ is signed and locked. It cannot be deleted.'; end if;
    return old;
  end if;
  if old.status = 'signed' then
    if new.status is distinct from old.status or new.data is distinct from old.data
       or new.client_id is distinct from old.client_id or new.user_id is distinct from old.user_id
       or new.form_version is distinct from old.form_version or new.completed_on is distinct from old.completed_on
       or new.signed_at is distinct from old.signed_at or new.expires_on is distinct from old.expires_on
       or new.needs_clearance is distinct from old.needs_clearance or new.created_at is distinct from old.created_at
       or (old.pdf_path is not null and new.pdf_path is distinct from old.pdf_path) then
      raise exception 'This PAR-Q+ is signed and locked. Start a new form instead.';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists parq_lock on public.parq_forms;
create trigger parq_lock before update or delete on public.parq_forms
  for each row execute function public.parq_lock();

-- Live updates between your devices
alter table public.parq_forms replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.parq_forms;
exception when duplicate_object then null; end $$;

-- 4) Private storage for signatures and PDFs -----------------------------------
--    Files live under <your user id>/<form id>/... · no public links · files can't be overwritten or deleted.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('parq-private', 'parq-private', false, 5242880, array['image/png','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/png','application/pdf'];

drop policy if exists "Owner can read PAR-Q files" on storage.objects;
drop policy if exists "Owner can add PAR-Q files"  on storage.objects;
create policy "Owner can read PAR-Q files" on storage.objects for select to authenticated
  using (bucket_id = 'parq-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Owner can add PAR-Q files" on storage.objects for insert to authenticated
  with check (bucket_id = 'parq-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- (No update or delete policy on purpose: signed files stay exactly as they were saved.)
