-- ============================================================================
-- Lana — migration 038: EnrollHere webhook inbox
--
-- Additive. Run after 037. Safe to re-run.
--
-- Every request EnrollHere sends to the enrollhere-webhook Edge Function is
-- stored here exactly as received, before anything tries to interpret it.
-- Two reasons:
--
--   1. EnrollHere's payload format is not published. The first job of the
--      endpoint is to capture real events so the mapping (recording URL,
--      client name, agent) is built against what they actually send.
--   2. Once mapping exists, a payload that fails to map is still on file and
--      can be reprocessed after a fix, instead of a sale silently going
--      missing.
--
-- The raw payload holds client names, so reads are admin-only. There is no
-- insert policy: only the Edge Function (service role) writes here.
-- ============================================================================

create table if not exists public.enrollhere_events (
  id            uuid primary key default gen_random_uuid(),
  received_at   timestamptz not null default now(),
  content_type  text,
  -- Parsed JSON or form body. Null when the body was neither; raw_body
  -- always has the original text.
  payload       jsonb,
  raw_body      text,
  -- Request headers minus anything credential-bearing — kept so a signature
  -- header (if EnrollHere signs its requests) shows up here.
  headers       jsonb,
  -- Filled in by the mapping step once it exists.
  processed_at  timestamptz,
  recording_id  uuid references public.call_recordings (id) on delete set null,
  error         text
);

create index if not exists enrollhere_events_received_idx
  on public.enrollhere_events (received_at desc);

alter table public.enrollhere_events enable row level security;

drop policy if exists enrollhere_events_admin_read on public.enrollhere_events;
create policy enrollhere_events_admin_read on public.enrollhere_events
  for select using (public.is_admin());
