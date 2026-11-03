-- ============================================================================
-- Lana — migration 059: autopay billing contact
--
-- Additive. Run after 058. Safe to re-run.
--
-- The name and email on each agency's Stripe customer, so receipts and
-- declined-card notices go to the agency. autopay-setup puts them on the
-- customer when it creates it and refreshes them on every "Set up autopay"
-- or "Change card".
--
-- The values themselves are not in this file (this repo is public). Set them
-- in the SQL editor:
--   update public.agency_autopay set billing_name = '…', billing_email = '…'
--   where team_id = (select id from public.teams where name = 'SBA');
-- ============================================================================

alter table public.agency_autopay
  add column if not exists billing_name  text,
  add column if not exists billing_email text;
