-- ============================================================================
-- Lana — migration 050: sales tax on agency payments
--
-- Additive. Run after 049. Safe to re-run.
--
-- Per Ryan 2026-10-29: Stripe works out sales tax at checkout (Stripe Tax,
-- automatic_tax) and adds it on top of the balance. The tax depends on the
-- payer's billing address, so it is only known once they pay.
--
--   agency_payments.amount_usd stays the part of the payment that pays down
--   the balance (before tax). tax_usd is the sales tax collected on top, so
--   paying a $100 balance with $7 tax clears exactly $100 — tax never turns
--   into a credit. The Billing page shows both.
-- ============================================================================

alter table public.agency_payments
  add column if not exists tax_usd numeric(12, 2) not null default 0 check (tax_usd >= 0);
