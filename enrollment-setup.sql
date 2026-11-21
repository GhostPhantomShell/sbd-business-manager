-- SBD Business Manager · Enrollment setup
-- Paste this whole script into Supabase → SQL Editor → New query, then click Run.
-- Safe to run more than once. It does not touch any existing data.
-- (Supabase will warn about "destructive operations": that is only the "drop ... if exists" lines,
--  which remove and recreate this script's own rules. No table or data is deleted.)

-- 1) Enrollments in progress -------------------------------------------------------
create table if not exists public.enrollments (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status      text not null default 'started' check (status in ('started','intake','plan','profile','parq','contract','active')),
  client_id   text,
  data        jsonb not null default '{}'::jsonb,   -- intake answers so far, plan choice, billing, links
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists enrollments_user on public.enrollments (user_id, status);
alter table public.enrollments enable row level security;
drop policy if exists "Owner can read enrollments"   on public.enrollments;
drop policy if exists "Owner can add enrollments"    on public.enrollments;
drop policy if exists "Owner can change enrollments" on public.enrollments;
drop policy if exists "Owner can delete enrollments" on public.enrollments;
create policy "Owner can read enrollments"   on public.enrollments for select to authenticated using (user_id = (select auth.uid()));
create policy "Owner can add enrollments"    on public.enrollments for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Owner can change enrollments" on public.enrollments for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Owner can delete enrollments" on public.enrollments for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.enrollments from anon;
grant select, insert, update, delete on public.enrollments to authenticated;
alter table public.enrollments replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.enrollments;
exception when duplicate_object then null; end $$;

-- 2) Submitted intakes, one row per version (add-only history) ------------------------
create table if not exists public.intake_submissions (
  id            text primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  enrollment_id text,
  client_id     text,
  version       integer not null default 1,
  answers       jsonb not null,
  submitted_at  timestamptz not null default now(),
  pdf_path      text,
  pdf_sha256    text
);
create index if not exists intake_submissions_client on public.intake_submissions (user_id, client_id);
alter table public.intake_submissions enable row level security;
drop policy if exists "Owner can read intakes" on public.intake_submissions;
drop policy if exists "Owner can add intakes"  on public.intake_submissions;
drop policy if exists "Owner can attach intake PDF" on public.intake_submissions;
create policy "Owner can read intakes" on public.intake_submissions for select to authenticated using (user_id = (select auth.uid()));
create policy "Owner can add intakes"  on public.intake_submissions for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Owner can attach intake PDF" on public.intake_submissions for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.intake_submissions from anon;
grant select, insert, update on public.intake_submissions to authenticated;
-- A submitted intake never changes; only its PDF can be attached, once.
create or replace function public.intake_lock() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.answers is distinct from old.answers or new.client_id is distinct from old.client_id or new.version is distinct from old.version
     or new.submitted_at is distinct from old.submitted_at or new.user_id is distinct from old.user_id or new.enrollment_id is distinct from old.enrollment_id
     or (old.pdf_path is not null and new.pdf_path is distinct from old.pdf_path)
     or (old.pdf_sha256 is not null and new.pdf_sha256 is distinct from old.pdf_sha256) then
    raise exception 'A submitted intake cannot be changed.';
  end if;
  return new;
end $$;
drop trigger if exists intake_lock on public.intake_submissions;
create trigger intake_lock before update on public.intake_submissions for each row execute function public.intake_lock();

-- 3) Discount history for reports (add-only) -------------------------------------------
create table if not exists public.discount_uses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id     text,
  enrollment_id text,
  discount_id   text,           -- empty for a custom discount
  name          text not null,
  kind          text not null check (kind in ('pct','amt')),
  amount        numeric not null,
  value_applied numeric not null,
  reason        text,
  plan_id       text,
  charge_id     text,
  used_at       timestamptz not null default now()
);
create index if not exists discount_uses_user on public.discount_uses (user_id, used_at);
alter table public.discount_uses enable row level security;
drop policy if exists "Owner can read discount uses" on public.discount_uses;
drop policy if exists "Owner can add discount uses"  on public.discount_uses;
create policy "Owner can read discount uses" on public.discount_uses for select to authenticated using (user_id = (select auth.uid()));
create policy "Owner can add discount uses"  on public.discount_uses for insert to authenticated with check (user_id = (select auth.uid()));
revoke all on public.discount_uses from anon;
grant select, insert on public.discount_uses to authenticated;

-- 4) Private storage for intake PDFs ----------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('enrollment-private', 'enrollment-private', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['application/pdf'];
drop policy if exists "Owner can read intake files" on storage.objects;
drop policy if exists "Owner can add intake files"  on storage.objects;
create policy "Owner can read intake files" on storage.objects for select to authenticated
  using (bucket_id = 'enrollment-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Owner can add intake files" on storage.objects for insert to authenticated
  with check (bucket_id = 'enrollment-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
