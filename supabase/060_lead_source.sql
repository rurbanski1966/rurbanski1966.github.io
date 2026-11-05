-- ============================================================================
-- Lana — migration 060: lead source on calls
--
-- Additive. Run after 059. Safe to re-run.
--
-- Per Ryan 2026-11-04: Call reviews gets a Lead Source dropdown when adding a
-- call. Stored as the label itself. The list must match LEAD_SOURCES in
-- public/js/config.js; to add a source, add it to both.
-- ============================================================================

alter table public.call_recordings add column if not exists lead_source text;

alter table public.call_recordings drop constraint if exists call_recordings_lead_source_check;
alter table public.call_recordings add constraint call_recordings_lead_source_check
  check (lead_source is null or lead_source in (
    'GFIII CPA',
    'BTF MA CPA',
    'BTF ANCILLARY CPA',
    '321 CPA',
    'ORBIX MA CPA',
    'RAPID HIP',
    'SPARK MA $135',
    'Spark MA CPA',
    'GET MEDICARE INSURANCES CPA'
  ));
