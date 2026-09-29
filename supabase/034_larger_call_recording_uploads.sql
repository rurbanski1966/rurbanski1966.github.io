-- ============================================================================
-- Lana — migration 034: allow larger call recording uploads
--
-- Additive. Run after 033. Safe to re-run.
--
-- Per Ryan 2026-09-29: the call-recordings bucket was capped at 100 MB
-- (migration 003's original insert). A long call at a decent bitrate can
-- get close to that on its own, so this raises the cap to 500 MB — plenty
-- of headroom for a multi-hour recording.
--
-- This is an UPDATE, not the original INSERT ... ON CONFLICT DO NOTHING —
-- the bucket already exists from 003, so that statement is a no-op against
-- an existing row and never changes file_size_limit on a live project.
-- ============================================================================

update storage.buckets
set file_size_limit = 524288000  -- 500 MB
where id = 'call-recordings';
