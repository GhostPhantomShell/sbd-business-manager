-- SBD Business Manager · Contracts setup
-- Paste this whole script into Supabase → SQL Editor → New query, then click Run.
-- Safe to run more than once. It does not touch any existing data.

-- 1) Contracts ------------------------------------------------------------------
create table if not exists public.contracts (
  id               text primary key,
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id        text not null,
  status           text not null default 'draft' check (status in ('draft','signed','cancelled')),
  template_id      text not null,                 -- e.g. pta-v1 (template versions are frozen; new versions are added)
  template_version integer not null,
  template_sha     text,                          -- fingerprint of the template text the client signed
  term             text check (term in ('a','b','c','d')),
  data             jsonb not null default '{}'::jsonb,  -- filled-in blanks and signature info
  start_date       date,
  end_date         date,
  remind_days      integer not null default 30,
  signed_at        timestamptz,
  supersedes_id    text,
  superseded_by_id text,
  cancelled_at     timestamptz,
  cancel_reason    text,
  pdf_path         text,
  pdf_sha256       text,                          -- SHA-256 of the signed PDF file
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists contracts_user_client on public.contracts (user_id, client_id);

alter table public.contracts enable row level security;
drop policy if exists "Owner can read contracts"   on public.contracts;
drop policy if exists "Owner can add contracts"    on public.contracts;
drop policy if exists "Owner can change contracts" on public.contracts;
drop policy if exists "Owner can delete contracts" on public.contracts;
create policy "Owner can read contracts"   on public.contracts for select to authenticated using (user_id = (select auth.uid()));
create policy "Owner can add contracts"    on public.contracts for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Owner can change contracts" on public.contracts for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Owner can delete contracts" on public.contracts for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.contracts from anon;
grant select, insert, update, delete on public.contracts to authenticated;

-- 2) Lock: once signed, the contract itself can never change or be deleted.
--    Only these tracking fields may change: superseded link (set once), cancellation, end date, reminder.
create or replace function public.contracts_lock() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'This contract is signed and locked. It cannot be deleted.'; end if;
    return old;
  end if;
  if old.status <> 'draft' then
    if new.data is distinct from old.data or new.client_id is distinct from old.client_id or new.user_id is distinct from old.user_id
       or new.template_id is distinct from old.template_id or new.template_version is distinct from old.template_version
       or new.template_sha is distinct from old.template_sha or new.term is distinct from old.term
       or new.start_date is distinct from old.start_date or new.signed_at is distinct from old.signed_at
       or new.supersedes_id is distinct from old.supersedes_id or new.pdf_path is distinct from old.pdf_path
       or new.pdf_sha256 is distinct from old.pdf_sha256 or new.created_at is distinct from old.created_at
       or (old.superseded_by_id is not null and new.superseded_by_id is distinct from old.superseded_by_id)
       or (new.status is distinct from old.status and not (old.status = 'signed' and new.status = 'cancelled')) then
      raise exception 'This contract is signed and locked. Use Replace / amend to make a new one.';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists contracts_lock on public.contracts;
create trigger contracts_lock before update or delete on public.contracts
  for each row execute function public.contracts_lock();

alter table public.contracts replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.contracts;
exception when duplicate_object then null; end $$;

-- 3) History log (add-only) -------------------------------------------------------
create table if not exists public.contract_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  contract_id text not null,
  at          timestamptz not null default now(),
  event       text not null,
  detail      jsonb not null default '{}'::jsonb
);
create index if not exists contract_events_contract on public.contract_events (contract_id);
alter table public.contract_events enable row level security;
drop policy if exists "Owner can read contract history" on public.contract_events;
drop policy if exists "Owner can add contract history"  on public.contract_events;
create policy "Owner can read contract history" on public.contract_events for select to authenticated using (user_id = (select auth.uid()));
create policy "Owner can add contract history"  on public.contract_events for insert to authenticated with check (user_id = (select auth.uid()));
revoke all on public.contract_events from anon;
grant select, insert on public.contract_events to authenticated;

-- 4) Private storage for contract signatures and PDFs ------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contracts-private', 'contracts-private', false, 10485760, array['image/png','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['image/png','application/pdf'];

drop policy if exists "Owner can read contract files" on storage.objects;
drop policy if exists "Owner can add contract files"  on storage.objects;
create policy "Owner can read contract files" on storage.objects for select to authenticated
  using (bucket_id = 'contracts-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Owner can add contract files" on storage.objects for insert to authenticated
  with check (bucket_id = 'contracts-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- (No update or delete policy on purpose: signed files stay exactly as they were saved.)
