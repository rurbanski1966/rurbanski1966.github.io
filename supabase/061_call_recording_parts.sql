-- ============================================================================
-- Lana — migration 061: one call, several recordings
--
-- Additive. Run after 060. Safe to re-run.
--
-- Per Ryan 2026-11-05: a call that drops and is finished on a follow-up call
-- is one sale, and must be graded as one. storage_path stays the first
-- recording; extra_storage_paths holds the follow-ups, in call order.
-- transcribe-call transcribes every part and joins them into the one
-- transcript the graders read, with a marker line between parts.
-- ============================================================================

alter table public.call_recordings
  add column if not exists extra_storage_paths text[] not null default '{}';
